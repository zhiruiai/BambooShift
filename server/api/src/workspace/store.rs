use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use sqlx::{
    Row, Sqlite, SqliteConnection, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug)]
pub enum Table {
    Agents,
    Conversations,
    Messages,
    Memories,
    Routines,
    Skills,
    Files,
    Settings,
}
impl Table {
    pub fn name(self) -> &'static str {
        match self {
            Self::Agents => "agents",
            Self::Conversations => "conversations",
            Self::Messages => "messages",
            Self::Memories => "memories",
            Self::Routines => "routines",
            Self::Skills => "skills",
            Self::Files => "files",
            Self::Settings => "settings",
        }
    }
}
#[derive(Clone, Debug)]
pub struct WorkspaceEvent {
    pub event: String,
    pub data: Value,
    pub revision: u64,
}
pub struct WorkspaceStore {
    pub pool: SqlitePool,
    pub directory: PathBuf,
    pub workspace_id: String,
    pub(crate) team_jobs: std::sync::Arc<crate::team_builder::TeamBuilderJobs>,
    pub(crate) bot_installs: std::sync::Arc<crate::bot_templates::InstallJobs>,
    pub(crate) credential_lock: tokio::sync::Mutex<()>,
    pub(crate) avatar_jobs: std::sync::Arc<super::avatar_jobs::AvatarJobs>,
    closed: AtomicBool,
    epoch: String,
    revision: AtomicU64,
    events: broadcast::Sender<WorkspaceEvent>,
}
impl WorkspaceStore {
    pub async fn open(directory: &Path) -> Result<Self> {
        Self::open_bound(directory, &directory.to_string_lossy()).await
    }
    pub(crate) async fn open_bound(directory: &Path, workspace_id: &str) -> Result<Self> {
        Self::connect(directory, workspace_id, true).await
    }
    pub(crate) async fn attach_existing_for_apps(
        directory: &Path,
        workspace_id: &str,
    ) -> Result<Self> {
        let meta = std::fs::symlink_metadata(directory)?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || !directory.join("openbot.sqlite").try_exists()?
        {
            return Err(ApiError::new(409, "来源应用存储不可用。"));
        }
        Self::connect(directory, workspace_id, false).await
    }
    async fn connect(directory: &Path, workspace_id: &str, initialize: bool) -> Result<Self> {
        if initialize {
            private_directory(directory)?;
        }
        let file = directory.join("openbot.sqlite");
        for suffix in ["", "-wal", "-shm", "-journal"] {
            validate_file(&directory.join(format!("openbot.sqlite{suffix}")))?;
        }
        if initialize {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&file) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            crate::db::private_file(&file)?;
        }
        let mut options = SqliteConnectOptions::new()
            .filename(&file)
            .create_if_missing(false)
            .foreign_keys(true)
            .pragma("secure_delete", "ON")
            .busy_timeout(Duration::from_secs(5));
        if initialize {
            options = options.journal_mode(SqliteJournalMode::Wal);
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        if initialize {
            sqlx::query("PRAGMA secure_delete=ON")
                .execute(&pool)
                .await?;
            for table in [
                Table::Agents,
                Table::Conversations,
                Table::Messages,
                Table::Memories,
                Table::Routines,
                Table::Skills,
                Table::Files,
                Table::Settings,
            ] {
                sqlx::query(&format!(
                    "CREATE TABLE IF NOT EXISTS {} (id TEXT PRIMARY KEY,data TEXT NOT NULL)",
                    table.name()
                ))
                .execute(&pool)
                .await?;
            }
        } else {
            let present: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_connections'",
            )
            .fetch_optional(&pool)
            .await?;
            if present.is_none() {
                pool.close().await;
                return Err(ApiError::new(409, "来源应用尚未准备就绪。"));
            }
        }
        let (events, _) = broadcast::channel(256);
        let store = Self {
            pool,
            directory: directory.to_owned(),
            workspace_id: workspace_id.to_owned(),
            epoch: uuid::Uuid::new_v4().to_string(),
            team_jobs: std::sync::Arc::new(crate::team_builder::TeamBuilderJobs::default()),
            credential_lock: tokio::sync::Mutex::new(()),
            bot_installs: std::sync::Arc::new(crate::bot_templates::InstallJobs::default()),
            avatar_jobs: std::sync::Arc::new(super::avatar_jobs::AvatarJobs::default()),
            closed: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            events,
        };
        if initialize {
            let mut tx = store.begin().await?;
            super::unread::initialize(&mut tx).await?;
            super::team_skills::initialize(&mut tx).await?;
            crate::speech::calls::initialize(&mut tx).await?;
            tx.commit().await?;
            crate::apps::store::initialize(&store).await?;
        }
        Ok(store)
    }
    pub async fn begin(&self) -> Result<Transaction<'_, Sqlite>> {
        Ok(self.pool.begin_with("BEGIN IMMEDIATE").await?)
    }
    pub async fn get(&self, table: Table, id: &str) -> Result<Option<Value>> {
        Self::get_in(&mut *self.pool.acquire().await?, table, id).await
    }
    pub async fn list(&self, table: Table) -> Result<Vec<Value>> {
        Self::list_in(&mut *self.pool.acquire().await?, table).await
    }
    pub(crate) async fn agent_knowledge(&self, table: Table, agent_id: &str) -> Result<Vec<Value>> {
        let query = match table {
            Table::Memories => {
                "SELECT data FROM memories WHERE json_extract(data,'$.agentId')=? ORDER BY rowid"
            }
            Table::Skills => {
                "SELECT data FROM skills WHERE json_extract(data,'$.agentId')=? AND json_extract(data,'$.status')='active' ORDER BY rowid"
            }
            _ => return Err(ApiError::bad("知识来源无效。")),
        };
        let rows = sqlx::query(query)
            .bind(agent_id)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| decode(table, row.get("data")))
            .collect()
    }
    pub async fn put(&self, table: Table, value: &Value) -> Result<Value> {
        Self::put_in(&mut *self.pool.acquire().await?, table, value).await
    }
    pub async fn delete(&self, table: Table, id: &str) -> Result<()> {
        Self::delete_in(&mut *self.pool.acquire().await?, table, id).await
    }
    pub async fn get_in(
        conn: &mut SqliteConnection,
        table: Table,
        id: &str,
    ) -> Result<Option<Value>> {
        let row = sqlx::query(&format!("SELECT data FROM {} WHERE id=?", table.name()))
            .bind(id)
            .fetch_optional(conn)
            .await?;
        row.map(|r| decode(table, r.get("data"))).transpose()
    }
    pub async fn list_in(conn: &mut SqliteConnection, table: Table) -> Result<Vec<Value>> {
        let rows = sqlx::query(&format!("SELECT data FROM {} ORDER BY rowid", table.name()))
            .fetch_all(conn)
            .await?;
        rows.into_iter()
            .map(|r| decode(table, r.get("data")))
            .collect()
    }
    pub async fn put_in(conn: &mut SqliteConnection, table: Table, value: &Value) -> Result<Value> {
        let id = value["id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 160)
            .ok_or_else(|| ApiError::bad("数据标识无效。"))?;
        if !value.is_object() {
            return Err(ApiError::bad("数据格式无效。"));
        }
        let data = serde_json::to_string(value).map_err(|_| ApiError::bad("数据格式无效。"))?;
        if data.len() > 16 * 1024 * 1024 {
            return Err(ApiError::new(413, "内容过大。"));
        }
        sqlx::query(&format!(
            "INSERT INTO {}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            table.name()
        ))
        .bind(id)
        .bind(data)
        .execute(conn)
        .await?;
        Ok(value.clone())
    }
    pub async fn delete_in(conn: &mut SqliteConnection, table: Table, id: &str) -> Result<()> {
        sqlx::query(&format!("DELETE FROM {} WHERE id=?", table.name()))
            .bind(id)
            .execute(conn)
            .await?;
        Ok(())
    }
    pub fn sync(&self) -> Value {
        json!({"epoch":self.epoch,"revision":self.revision.load(Ordering::SeqCst)})
    }
    pub fn emit(&self, event: &str, data: Value) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.events.send(WorkspaceEvent {
            event: event.to_owned(),
            data,
            revision,
        });
    }
    pub fn subscribe(&self) -> broadcast::Receiver<WorkspaceEvent> {
        self.events.subscribe()
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.emit("close", json!({}));
        self.team_jobs.close().await;
        self.avatar_jobs.close().await;
        self.pool.close().await;
    }
}
fn decode(table: Table, data: String) -> Result<Value> {
    let mut value: Value =
        serde_json::from_str(&data).map_err(|_| ApiError::new(409, "工作空间数据格式无效。"))?;
    if !value.is_object() {
        return Err(ApiError::new(409, "工作空间数据格式无效。"));
    }
    if matches!(table, Table::Agents) {
        super::profiles::project_revision(&mut value);
    }
    Ok(value)
}
pub(super) fn private_directory(path: &Path) -> Result<()> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(ApiError::bad("工作空间存储路径不可用。"));
        }
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn validate_file(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(ApiError::bad("工作空间存储文件不可用。"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.nlink() != 1 {
                    return Err(ApiError::bad("工作空间存储文件不可用。"));
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
