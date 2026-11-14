use super::{Table, WorkspaceStore};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Read,
};

fn path(store: &WorkspaceStore) -> std::path::PathBuf {
    store.directory.join("config/models.private.json")
}
fn document(store: &WorkspaceStore) -> Result<Value> {
    let directory = store.directory.join("config");
    match fs::symlink_metadata(&directory) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            return Err(ApiError::new(409, "私有模型配置目录不可用。"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"version":1,"entries":{}}));
        }
        Err(e) => return Err(e.into()),
    };
    let path = path(store);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"version":1,"entries":{}}));
        }
        Err(e) => return Err(e.into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4 * 1024 * 1024 {
        return Err(ApiError::new(409, "私有模型配置不可用。"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.nlink() != 1 || meta.permissions().mode() & 0o077 != 0 {
            return Err(ApiError::new(409, "私有模型配置权限无效。"));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let held = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if held.dev() != meta.dev() || held.ino() != meta.ino() || held.nlink() != 1 {
            return Err(ApiError::new(409, "私有模型配置在读取时发生变化。"));
        }
    }
    let mut text = String::new();
    file.take(4 * 1024 * 1024 + 1).read_to_string(&mut text)?;
    if text.len() > 4 * 1024 * 1024 {
        return Err(ApiError::new(413, "私有模型配置过大。"));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|_| ApiError::new(409, "私有模型配置损坏。"))?;
    if value["version"] != 1 || !value["entries"].is_object() {
        return Err(ApiError::new(409, "私有模型配置格式无效。"));
    }
    Ok(value)
}
fn write(store: &WorkspaceStore, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| ApiError::new(409, "私有模型配置无效。"))?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(ApiError::new(413, "私有模型配置数量过多。"));
    }
    crate::filesystem::write_private(&path(store), &bytes)?;
    Ok(())
}
/** Publish a new immutable entry before the database references it. Rollback never changes old credentials. */
pub fn stage(
    store: &WorkspaceStore,
    profile_id: &str,
    provider: &Value,
    endpoint: &Value,
    key: &str,
) -> Result<String> {
    let mut value = document(store)?;
    let reference = uuid::Uuid::new_v4().to_string();
    value["entries"][&reference] = json!({"workspace":store.workspace_id,"profileId":profile_id,"provider":provider,"baseUrl":endpoint,"apiKey":key});
    write(store, &value)?;
    Ok(reference)
}
pub fn key(store: &WorkspaceStore, profile_id: &str, profile: &Value) -> Result<String> {
    let Some(reference) = profile["credentialRef"].as_str() else {
        return Ok(String::new());
    };
    let value = document(store)?;
    let entry = &value["entries"][reference];
    if entry["workspace"] != store.workspace_id
        || entry["profileId"] != profile_id
        || entry["provider"] != profile["provider"]
        || entry["baseUrl"] != profile["baseUrl"]
    {
        return Ok(String::new());
    }
    Ok(entry["apiKey"].as_str().unwrap_or("").to_owned())
}
/** Remove only unreferenced entries after the database commit, under the model mutation lock. */
pub async fn collect(store: &WorkspaceStore) -> Result<()> {
    let mut value = document(store)?;
    let references: HashSet<String> = store
        .list(Table::Settings)
        .await?
        .into_iter()
        .filter(|p| {
            p["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("model-profile:"))
        })
        .filter_map(|p| p["credentialRef"].as_str().map(str::to_owned))
        .collect();
    let entries = value["entries"].as_object_mut().unwrap();
    let before = entries.len();
    entries.retain(|id, _| references.contains(id));
    if before != entries.len() {
        write(store, &value)?;
    }
    Ok(())
}
pub async fn migrate(store: &WorkspaceStore, conn: &mut sqlx::SqliteConnection) -> Result<()> {
    let records = WorkspaceStore::list_in(conn, Table::Settings).await?;
    let active = records.iter().find(|p| p["id"] == "model");
    let legacy = records.iter().find(|p| p["id"] == "secrets");
    for mut profile in records
        .iter()
        .filter(|p| {
            p["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("model-profile:"))
        })
        .cloned()
    {
        let profile_id = profile["id"]
            .as_str()
            .unwrap()
            .trim_start_matches("model-profile:")
            .to_owned();
        let secret_id = format!("model-profile-secret:{profile_id}");
        let exact = records.iter().find(|p| {
            p["id"] == secret_id
                && p["provider"] == profile["provider"]
                && p["baseUrl"] == profile["baseUrl"]
        });
        let old = if active.is_some_and(|a| a["profileId"] == profile_id) {
            legacy.filter(|p| p["provider"] == profile["provider"])
        } else {
            None
        };
        let inline = profile["apiKey"].as_str().map(str::to_owned);
        let key = exact
            .or(old)
            .and_then(|s| s["apiKey"].as_str())
            .map(str::to_owned)
            .or(inline);
        if let Some(key) = key.filter(|k| !k.is_empty()) {
            profile["credentialRef"] = json!(stage(
                store,
                &profile_id,
                &profile["provider"],
                &profile["baseUrl"],
                &key
            )?);
        }
        profile.as_object_mut().unwrap().remove("apiKey");
        WorkspaceStore::put_in(conn, Table::Settings, &profile).await?;
    }
    for record in &records {
        let Some(id) = record["id"].as_str() else {
            continue;
        };
        if id == "secrets" || id.starts_with("model-profile-secret:") {
            WorkspaceStore::delete_in(conn, Table::Settings, id).await?;
        }
    }
    if let Some(active) = active {
        let mut clean = active.clone();
        clean.as_object_mut().unwrap().remove("apiKey");
        WorkspaceStore::put_in(conn, Table::Settings, &clean).await?;
    }
    Ok(())
}
