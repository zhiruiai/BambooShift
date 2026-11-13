use super::{SourceDatabase, Workspace};
use crate::{config::Config, db::State, error::ApiError};
use serde_json::{Value, json};
use sqlx::{
    Connection, SqliteConnection,
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};
use std::{fs, path::PathBuf};

fn workspace() -> Workspace {
    let id = uuid::Uuid::new_v4().to_string();
    Workspace {
        id: id.clone(),
        key: id,
        name: "Synthetic source workspace".into(),
        kind: "team".into(),
    }
}

fn unavailable(error: ApiError) {
    assert_eq!(error.status.as_u16(), 403);
    assert_eq!(error.code, "SHARED_BOT_UNAVAILABLE");
}

struct Fixture {
    temporary: tempfile::TempDir,
    state: State,
    workspace: Workspace,
    directory: PathBuf,
    writer: Option<SqliteConnection>,
    agent: Value,
}

impl Fixture {
    async fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let state = State::open(Config::local(temporary.path())).await.unwrap();
        let workspace = workspace();
        let directory = temporary.path().join("spaces").join(&workspace.id);
        fs::create_dir_all(&directory).unwrap();
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(directory.join("openbot.sqlite"))
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE skills(id TEXT PRIMARY KEY, data TEXT NOT NULL);",
        )
        .execute(&mut writer)
        .await
        .unwrap();
        let agent = json!({"id":"synthetic-agent","name":"Synthetic source",
            "role":"Researcher","description":"Only synthetic test data",
            "instructions":"Use verified synthetic results.","avatar":"leaf","color":"#38a169"});
        sqlx::query("INSERT INTO agents(id,data) VALUES (?,?)")
            .bind(agent["id"].as_str().unwrap())
            .bind(agent.to_string())
            .execute(&mut writer)
            .await
            .unwrap();
        Self {
            temporary,
            state,
            workspace,
            directory,
            writer: Some(writer),
            agent,
        }
    }

    async fn close(mut self) {
        if let Some(writer) = self.writer.take() {
            writer.close().await.unwrap();
        }
        self.state.close().await;
        drop(self.state);
        self.temporary.close().unwrap();
    }
}

async fn close_source(source: SourceDatabase) {
    let SourceDatabase {
        conn,
        directory: _,
        files,
    } = source;
    conn.close().await.unwrap();
    drop(files);
}

#[tokio::test]
async fn readonly_source_remains_valid_after_real_wal_updates_and_truncate_checkpoints() {
    let mut fixture = Fixture::new().await;
    let mut source = SourceDatabase::open(&fixture.state, &fixture.workspace)
        .await
        .unwrap();
    let id = fixture.agent["id"].as_str().unwrap().to_owned();
    let initial = source.read(&id).await.unwrap();
    assert_eq!(initial.profile["name"], fixture.agent["name"]);
    let mut revision = initial.revision;
    for version in 1..=3 {
        fixture.agent["name"] = json!(format!("Synthetic source {version}"));
        sqlx::query("UPDATE agents SET data=? WHERE id=?")
            .bind(fixture.agent.to_string())
            .bind(&id)
            .execute(fixture.writer.as_mut().unwrap())
            .await
            .unwrap();
        source.check().unwrap();
        let updated = source.read(&id).await.unwrap();
        assert_eq!(updated.profile["name"], fixture.agent["name"]);
        assert_ne!(updated.revision, revision);
        revision = updated.revision;
        let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(fixture.writer.as_mut().unwrap())
            .await
            .unwrap();
        assert_eq!(
            busy, 0,
            "Completed source reads must not hold a WAL snapshot"
        );
        source.check().unwrap();
        assert_eq!(source.read(&id).await.unwrap().revision, revision);
    }
    let error = sqlx::query("DELETE FROM agents")
        .execute(&mut source.conn)
        .await
        .unwrap_err();
    let code = error
        .as_database_error()
        .unwrap()
        .code()
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert_eq!(
        code & 0xff,
        8,
        "Source connection must remain SQLITE_READONLY"
    );
    assert_eq!(source.agent(&id).await.unwrap(), fixture.agent);
    close_source(source).await;
    fixture.close().await;
}

#[tokio::test]
async fn readonly_source_missing_parent_or_main_returns_403_without_creating_storage() {
    let temporary = tempfile::tempdir().unwrap();
    let state = State::open(Config::local(temporary.path())).await.unwrap();
    let workspace = workspace();
    let directory = temporary.path().join("spaces").join(&workspace.id);
    unavailable(
        SourceDatabase::open(&state, &workspace)
            .await
            .err()
            .unwrap(),
    );
    assert!(!directory.exists());
    fs::create_dir_all(&directory).unwrap();
    unavailable(
        SourceDatabase::open(&state, &workspace)
            .await
            .err()
            .unwrap(),
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
    state.close().await;
    drop(state);
    temporary.close().unwrap();
}

#[tokio::test]
async fn retained_source_description_returns_403_for_replaced_or_missing_main() {
    let mut fixture = Fixture::new().await;
    let mut source = SourceDatabase::open(&fixture.state, &fixture.workspace)
        .await
        .unwrap();
    source.check().unwrap();
    fixture.writer.take().unwrap().close().await.unwrap();
    // Keep the exact SourceDatabase/DatabaseFiles description under test, but
    // release SQLite's own source handle so Windows can exercise a real rename.
    // The replacement connection is memory-only and never accesses the source.
    let memory = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    let original = std::mem::replace(&mut source.conn, memory);
    original.close().await.unwrap();
    source.check().unwrap();
    let main = fixture.directory.join("openbot.sqlite");
    let previous = fixture.directory.join("previous.sqlite");
    fs::rename(&main, &previous).unwrap();
    unavailable(source.check().unwrap_err());
    assert!(!main.exists());
    fs::write(&main, b"REPLACEMENT CANARY").unwrap();
    unavailable(source.check().unwrap_err());
    assert_eq!(fs::read(&main).unwrap(), b"REPLACEMENT CANARY");
    fs::remove_file(&main).unwrap();
    fs::rename(&previous, &main).unwrap();
    source.check().unwrap();
    close_source(source).await;
    fixture.close().await;
}
