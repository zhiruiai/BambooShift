use super::blueprint;
use crate::{
    db::{State, storage::DatabaseFiles},
    error::{ApiError, Result},
    workspace::WorkspaceAccess,
};
use serde_json::{Value, json};
use sqlx::{
    Row, SqliteConnection, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub struct BotTemplates {
    pub(crate) pool: SqlitePool,
    closed: AtomicBool,
    pub(crate) operations: std::sync::Arc<tokio::sync::Mutex<()>>,
    pending: std::sync::Mutex<std::collections::HashSet<String>>,
}
pub(super) struct MutationLease<'a>(&'a BotTemplates, String);
impl Drop for MutationLease<'_> {
    fn drop(&mut self) {
        self.0.pending.lock().unwrap().remove(&self.1);
    }
}

pub(super) struct Template {
    pub row: Value,
    pub avatar: Option<Vec<u8>>,
}
impl BotTemplates {
    pub async fn open(data: &Path) -> Result<Self> {
        let files = DatabaseFiles::prepare(data, &["platform"], "bot-templates.sqlite")
            .map_err(|_| ApiError::new(503, "模板存储不可用。"))?;
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(files.path())
                    .create_if_missing(false)
                    .journal_mode(SqliteJournalMode::Wal)
                    .busy_timeout(Duration::from_secs(5)),
            )
            .await?;
        if files.check().is_err() {
            pool.close().await;
            return Err(ApiError::new(503, "模板存储不可用。"));
        }
        for sql in [
            "CREATE TABLE IF NOT EXISTS sharing_policies(workspace_id TEXT PRIMARY KEY,data TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,data TEXT NOT NULL,avatar BLOB)",
            "CREATE INDEX IF NOT EXISTS templates_workspace ON templates(workspace_id)",
            "CREATE TABLE IF NOT EXISTS template_versions(id TEXT PRIMARY KEY,template_id TEXT NOT NULL,workspace_id TEXT NOT NULL,data TEXT NOT NULL,avatar BLOB)",
            "CREATE TABLE IF NOT EXISTS template_links(token TEXT PRIMARY KEY,template_id TEXT NOT NULL,version_id TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)",
            "CREATE INDEX IF NOT EXISTS template_links_template ON template_links(template_id)",
            "CREATE TABLE IF NOT EXISTS template_mutations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,workspace_id TEXT NOT NULL,digest TEXT NOT NULL,template_id TEXT NOT NULL,PRIMARY KEY(actor_id,request_id))",
        ] {
            sqlx::query(sql).execute(&pool).await?;
        }
        Ok(Self {
            pool,
            closed: AtomicBool::new(false),
            operations: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            pending: std::sync::Mutex::new(std::collections::HashSet::new()),
        })
    }
    pub(super) fn pending(&self, actor: &str, id: &str) -> bool {
        self.pending
            .lock()
            .unwrap()
            .contains(&format!("{actor}:{id}"))
    }
    pub(super) fn reserve(&self, actor: &str, id: &str) -> Result<MutationLease<'_>> {
        self.ensure_open()?;
        let key = format!("{actor}:{id}");
        let mut pending = self.pending.lock().unwrap();
        if pending.contains(&key) {
            return Err(ApiError::new(409, "这次模板操作仍在处理中，请核对原回执。"));
        }
        if pending.len() >= 128 {
            return Err(ApiError::new(429, "模板操作繁忙，请稍后重试。"));
        }
        pending.insert(key.clone());
        Ok(MutationLease(self, key))
    }
    pub fn ensure_open(&self) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            Err(ApiError::new(503, "模板服务正在关闭。"))
        } else {
            Ok(())
        }
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.pool.close().await;
    }
}
pub(super) async fn read(conn: &mut SqliteConnection, wid: &str, id: &str) -> Result<Template> {
    let value = sqlx::query("SELECT data,avatar FROM templates WHERE id=? AND workspace_id=?")
        .bind(id)
        .bind(wid)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| ApiError::new(404, "模板不存在或不属于当前空间。"))?;
    let row: Value = serde_json::from_str(value.get("data"))
        .map_err(|_| ApiError::new(409, "模板数据暂不可用。"))?;
    if row["id"] != id
        || row["workspaceId"] != wid
        || row["createdBy"].as_str().is_none()
        || row["sequence"].as_u64().is_none()
    {
        return Err(ApiError::new(409, "模板来源信息无效。"));
    }
    let avatar: Option<Vec<u8>> = value.get("avatar");
    blueprint::validate(&row["blueprint"], avatar.as_deref())?;
    Ok(Template { row, avatar })
}
pub(super) async fn save(conn: &mut SqliteConnection, value: &Template) -> Result<()> {
    sqlx::query("INSERT INTO templates(id,workspace_id,data,avatar) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,avatar=excluded.avatar").bind(value.row["id"].as_str()).bind(value.row["workspaceId"].as_str()).bind(value.row.to_string()).bind(&value.avatar).execute(conn).await?;
    Ok(())
}
pub(super) fn view(row: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "id",
        "sourceAgentId",
        "sourceConversationId",
        "messageId",
        "sequence",
        "revision",
        "draftRevision",
        "draftDigest",
        "blueprint",
        "projectionPending",
        "createdAt",
        "updatedAt",
    ] {
        result[key] = row[key].clone();
    }
    if row["blueprint"].get("avatar").is_some() {
        result["avatarPath"] = json!(format!(
            "/api/workspaces/{}/bot-templates/{}/avatar?revision={}",
            row["workspaceId"].as_str().unwrap(),
            row["id"].as_str().unwrap(),
            row["draftRevision"].as_str().unwrap()
        ));
    }
    if let Some(p) = row.get("publication") {
        result["publication"] = json!({"revision":p["versionId"],"digest":p["digest"],"audience":p["audience"],"publishedAt":p["publishedAt"],"path":format!("/templates/{}",p["token"].as_str().unwrap_or(""))});
    }
    result
}
pub(super) fn touch(row: &mut Value) {
    row["sequence"] = json!(row["sequence"].as_u64().unwrap() + 1);
    row["revision"] = json!(uuid::Uuid::new_v4().to_string());
    row["updatedAt"] = json!(crate::db::iso(crate::db::now()));
    row["projectionPending"] = json!(true);
}
pub(super) fn revision(row: &Value, body: &Value, draft: bool) -> Result<()> {
    if row["revision"] != body["expectedRevision"]
        || draft && row["draftRevision"] != body["expectedDraftRevision"]
    {
        Err(ApiError::new(409, "模板已更新，请重新载入并核对。").with_code("BOT_TEMPLATE_CONFLICT"))
    } else {
        Ok(())
    }
}
pub(super) async fn policy(conn: &mut SqliteConnection, wid: &str, kind: &str) -> Result<Value> {
    let raw =
        sqlx::query_scalar::<_, String>("SELECT data FROM sharing_policies WHERE workspace_id=?")
            .bind(wid)
            .fetch_optional(conn)
            .await?;
    let value = match raw {
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|_| ApiError::new(409, "模板分享策略无效。"))?
        }
        None => json!({"revision":"unset","mode":if kind=="team"{"team-only"}else{"public"}}),
    };
    if !matches!(
        value["mode"].as_str(),
        Some("public" | "team-only" | "disabled")
    ) || value["revision"].as_str().is_none()
    {
        return Err(ApiError::new(409, "模板分享策略无效。"));
    }
    Ok(value)
}
pub(super) async fn source_available(state: &State, wid: &str, creator: &str) -> Result<String> {
    sqlx::query_scalar::<_,String>("SELECT w.kind FROM workspaces w JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id WHERE w.id=? AND w.status='active' AND u.id=? AND u.status='active' AND m.role='owner'").bind(wid).bind(creator).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::new(404,"模板来源不可用。"))
}
pub(super) async fn prior(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    request: &str,
    digest: Option<&str>,
) -> Result<Option<Template>> {
    let row=sqlx::query("SELECT workspace_id,digest,template_id FROM template_mutations WHERE actor_id=? AND request_id=?").bind(&grant.user_id).bind(request).fetch_optional(&mut *conn).await?;
    let Some(row) = row else { return Ok(None) };
    if row.get::<String, _>("workspace_id") != grant.workspace_id
        || digest.is_some_and(|d| row.get::<String, _>("digest") != d)
    {
        return Err(ApiError::new(409, "这个请求编号已用于其他模板操作。")
            .with_code("BOT_TEMPLATE_REQUEST_CONFLICT"));
    }
    Ok(Some(
        read(
            conn,
            &grant.workspace_id,
            &row.get::<String, _>("template_id"),
        )
        .await?,
    ))
}
pub(super) async fn quota(conn: &mut SqliteConnection, wid: &str) -> Result<()> {
    let row=sqlx::query("SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))+coalesce(length(avatar),0)),0) AS size FROM templates WHERE workspace_id=?").bind(wid).fetch_one(&mut *conn).await?;
    let published:i64=sqlx::query_scalar("SELECT coalesce(sum(length(CAST(data AS BLOB))+coalesce(length(avatar),0)),0) FROM template_versions WHERE workspace_id=?").bind(wid).fetch_one(conn).await?;
    if row.get::<i64, _>("count") > 100 || row.get::<i64, _>("size") + published > 256 * 1024 * 1024
    {
        return Err(ApiError::new(
            409,
            "当前空间模板存储已达上限。已有模板仍然保留。",
        ));
    }
    Ok(())
}
