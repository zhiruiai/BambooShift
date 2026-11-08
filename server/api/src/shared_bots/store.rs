use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqliteConnection, SqlitePool, sqlite::SqliteConnectOptions};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub id: String,
    pub source_workspace_id: String,
    pub source_agent_id: String,
    pub created_by: String,
    pub target_team_id: String,
    pub audience: String,
    pub member_ids: Vec<String>,
    pub status: String,
    pub revision: String,
    pub access_revision: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apps: Option<Vec<Value>>,
}
pub struct SharedBots {
    pub(crate) pool: SqlitePool,
    closed: AtomicBool,
}
pub fn unavailable() -> ApiError {
    ApiError::new(403, "此 Bot 的分享或团队权限已不可用；个人历史仍保留。")
        .with_code("SHARED_BOT_UNAVAILABLE")
}
pub fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
pub fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn sha(value: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_ref()))
}
impl SharedBots {
    pub async fn open(root: &Path) -> Result<Self> {
        let path = root.join("platform/shared-bots.sqlite");
        for suffix in ["", "-wal", "-shm", "-journal"] {
            super::source::safe_file(
                &path.with_file_name(format!("shared-bots.sqlite{suffix}")),
                true,
            )?;
        }
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600);
        }
        match open.open(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        crate::db::private_file(&path)?;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(false)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                    .busy_timeout(Duration::from_secs(5)),
            )
            .await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS shared_bots(id TEXT PRIMARY KEY,source_workspace_id TEXT NOT NULL,source_agent_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(source_workspace_id,source_agent_id))").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS shared_bot_mutations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,share_id TEXT NOT NULL,PRIMARY KEY(actor_id,request_id))").execute(&pool).await?;
        Ok(Self {
            pool,
            closed: AtomicBool::new(false),
        })
    }
    pub fn ensure_open(&self) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(503, "共享服务正在关闭。"));
        }
        Ok(())
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.pool.close().await;
    }
    pub async fn get(&self, id: &str) -> Result<Share> {
        self.ensure_open()?;
        if !uuid(id) {
            return Err(unavailable());
        }
        Self::get_in(&mut *self.pool.acquire().await?, id)
            .await?
            .ok_or_else(unavailable)
    }
    pub(crate) async fn get_in(conn: &mut SqliteConnection, id: &str) -> Result<Option<Share>> {
        let row = sqlx::query(
            "SELECT id,source_workspace_id,source_agent_id,data FROM shared_bots WHERE id=?",
        )
        .bind(id)
        .fetch_optional(conn)
        .await?;
        row.map(decode).transpose()
    }
    pub(crate) async fn source_in(
        conn: &mut SqliteConnection,
        wid: &str,
        agent: &str,
    ) -> Result<Option<Share>> {
        let row=sqlx::query("SELECT id,source_workspace_id,source_agent_id,data FROM shared_bots WHERE source_workspace_id=? AND source_agent_id=?").bind(wid).bind(agent).fetch_optional(conn).await?;
        row.map(decode).transpose()
    }
    pub(crate) async fn put(conn: &mut SqliteConnection, share: &Share) -> Result<()> {
        sqlx::query("INSERT INTO shared_bots(id,source_workspace_id,source_agent_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
            .bind(&share.id).bind(&share.source_workspace_id).bind(&share.source_agent_id).bind(serde_json::to_string(share).map_err(|_|unavailable())?).execute(conn).await?;
        Ok(())
    }
    pub async fn request_not_applied(&self, actor: &str, request: &Value) -> bool {
        if self.ensure_open().is_err() {
            return false;
        }
        let Some(id) = request.as_str().filter(|id| uuid(id)) else {
            return false;
        };
        sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM shared_bot_mutations WHERE actor_id=? AND request_id=?",
        )
        .bind(actor)
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .is_ok_and(|row| row.is_none())
    }
}
fn decode(row: sqlx::sqlite::SqliteRow) -> Result<Share> {
    let data: String = row.get("data");
    if data.len() > 1024 * 1024 {
        return Err(unavailable());
    }
    let value: Share = serde_json::from_str(&data).map_err(|_| unavailable())?;
    if value.id != row.get::<String, _>("id")
        || value.source_workspace_id != row.get::<String, _>("source_workspace_id")
        || value.source_agent_id != row.get::<String, _>("source_agent_id")
        || ![
            &value.id,
            &value.source_workspace_id,
            &value.created_by,
            &value.target_team_id,
            &value.revision,
            &value.access_revision,
        ]
        .iter()
        .all(|s| uuid(s))
        || !opaque(&value.source_agent_id)
        || !["team", "selected"].contains(&value.audience.as_str())
        || !["active", "revoked"].contains(&value.status.as_str())
        || value.member_ids.len() > 200
        || !value.member_ids.iter().all(|s| opaque(s))
        || value
            .member_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != value.member_ids.len()
        || (value.audience == "team" && !value.member_ids.is_empty())
        || (value.audience == "selected" && value.member_ids.is_empty())
        || chrono::DateTime::parse_from_rfc3339(&value.created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&value.updated_at).is_err()
    {
        return Err(unavailable());
    }
    super::resources::validate_grants(&value)?;
    Ok(value)
}
