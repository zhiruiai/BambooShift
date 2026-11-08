use openbot_backend::{config::Config, db::State, workspace::Table};
use serde_json::{Value, json};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn private_json(path: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 16384 {
        return Err("Invalid rehearsal marker".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err("Rehearsal marker must be private".into());
        }
    }
    let mut bytes = vec![];
    std::io::Read::by_ref(&mut file)
        .take(16385)
        .read_to_end(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
async fn run(directory: PathBuf, output: PathBuf) -> Result<Value, Box<dyn std::error::Error>> {
    if std::fs::symlink_metadata(&directory)?
        .file_type()
        .is_symlink()
    {
        return Err("Rehearsal directory cannot be a link".into());
    }
    let directory = directory.canonicalize()?;
    let marker = private_json(&directory.join(".openbot-migration-copy.json"))?;
    if marker["version"] != 1 || marker["purpose"] != "offline-migration-rehearsal" {
        return Err("An explicit restored rehearsal copy is required".into());
    }
    let backup = PathBuf::from(
        marker["backup"]
            .as_str()
            .ok_or("Invalid backup reference")?,
    )
    .canonicalize()?;
    if backup == directory || directory.starts_with(&backup) || backup.starts_with(&directory) {
        return Err("Rehearsal and backup must be separate".into());
    }
    use sha2::{Digest, Sha256};
    let backup_bytes = std::fs::read(backup.join(".openbot-backup.json"))?;
    if marker["manifestSha256"] != hex::encode(Sha256::digest(&backup_bytes)) {
        return Err("Backup manifest changed".into());
    }
    let backup_manifest: Value = serde_json::from_slice(&backup_bytes)?;
    if backup_manifest["source"]
        .as_str()
        .is_some_and(|s| Path::new(s) == directory)
    {
        return Err("The original data directory is forbidden".into());
    }
    let identity = directory.join("platform/identity.sqlite");
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&identity)
            .read_only(true),
    )
    .await?;
    let rows = sqlx::query("SELECT id,storage_key,kind FROM workspaces ORDER BY rowid")
        .fetch_all(&mut db)
        .await?;
    db.close().await?;
    let mut config = Config::local(&directory);
    config.bind = "127.0.0.1:0".parse()?;
    config.node_binary = PathBuf::from("/__openbot_offline_probe_no_execution__");
    let state = State::open(config).await.map_err(|e| e.message)?;
    // No listener, scheduler.start, agent submission, app reconnect, or computer target is invoked.
    let result = async {
        let mut spaces = vec![];
        for (index, row) in rows.iter().enumerate() {
            let id: String = row.get("id");
            let key: String = row.get("storage_key");
            let kind: String = row.get("kind");
            let path = if key == "legacy" {
                directory.join("openbot.sqlite")
            } else {
                directory.join("spaces").join(&key).join("openbot.sqlite")
            };
            if !path.exists() {
                spaces.push(json!({"slot": index, "kind": kind, "initialized": false}));
                continue;
            }
            let store = state.workspace.get(&id, &key).await.map_err(|e| e.message)?;
            let _controller = state.computer.get(&state, store.clone()).await.map_err(|e| e.message)?;
            let mut counts = serde_json::Map::new();
            for table in [
                Table::Agents, Table::Conversations, Table::Messages, Table::Memories,
                Table::Routines, Table::Skills, Table::Files, Table::Settings,
            ] {
                counts.insert(table.name().into(), json!(store.list(table).await.map_err(|e| e.message)?.len()));
            }
            let refs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings WHERE id LIKE 'model-profile:%' AND json_type(data,'$.credentialRef')='text'",
            ).fetch_one(&store.pool).await?;
            let inline: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings WHERE id='secrets' OR id LIKE 'model-profile-secret:%' OR json_type(data,'$.apiKey')='text'",
            ).fetch_one(&store.pool).await?;
            let apps: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM app_connections WHERE json_type(data,'$.credentialRef')='text'",
            ).fetch_one(&store.pool).await?;
            let app_inline: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM app_connections WHERE json_type(data,'$.token')='text' OR json_type(data,'$.oauth')='object'",
            ).fetch_one(&store.pool).await?;
            let model_config = openbot_backend::workspace::model::runtime_config(&store)
                .await.map_err(|e| e.message)?;
            spaces.push(json!({
                "slot": index,
                "kind": kind,
                "legacy": key == "legacy",
                "initialized": true,
                "counts": counts,
                "credentials": {
                    "modelReferences": refs,
                    "inlineModelSecrets": inline,
                    "appReferences": apps,
                    "inlineAppSecrets": app_inline,
                    "activeModelKeyReadable": model_config["apiKey"].as_str().is_some_and(|s| !s.is_empty()),
                },
                "activeTasks": state.agent_runs.requests(&id).await.len(),
            }));
        }
        Ok::<_, Box<dyn std::error::Error>>(json!({
            "version": 1,
            "offline": true,
            "schedulerStarted": false,
            "listenersStarted": false,
            "workspaces": spaces,
        }))
    }.await;
    state.close().await;
    let report = result?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(output)?;
    file.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    file.sync_all()?;
    Ok(json!({"verified":true,"workspaces":rows.len(),"offline":true}))
}
#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 || args[0] != "--rehearsal-dir" || args[2] != "--report" {
        eprintln!(
            "Usage: openbot-migration-probe --rehearsal-dir RESTORED_COPY --report NEW_PRIVATE_FILE"
        );
        std::process::exit(2);
    }
    match run(PathBuf::from(&args[1]), PathBuf::from(&args[3])).await {
        Ok(summary) => println!("{summary}"),
        Err(_) => {
            eprintln!(
                "Offline migration verification failed; the original data was not opened for migration. Inspect the isolated copy privately."
            );
            std::process::exit(1);
        }
    }
}
