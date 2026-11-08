use crate::{
    db::{iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS teaching_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,data TEXT NOT NULL)").execute(&mut *conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS teaching_generations(user_id TEXT NOT NULL,request_id TEXT NOT NULL,session_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(user_id,request_id))").execute(&mut *conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS teaching_closures(user_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(user_id,id))").execute(&mut *conn).await?;
    let rows: Vec<String> = sqlx::query_scalar("SELECT data FROM teaching_sessions")
        .fetch_all(&mut *conn)
        .await?;
    for raw in rows {
        let mut value: Value = decode(&raw)?;
        if ["recording", "generating"].contains(&value["status"].as_str().unwrap_or("")) {
            value["status"] = json!("interrupted");
            value["interrupted"] = json!(true);
            value["reason"] = json!("service_restarted");
            stamp(&mut value);
            save(conn, &value).await?;
        }
    }
    Ok(())
}
pub async fn get(conn: &mut SqliteConnection, id: &str, actor: &WorkspaceAccess) -> Result<Value> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT data FROM teaching_sessions WHERE id=? AND user_id=?")
            .bind(id)
            .bind(&actor.user_id)
            .fetch_optional(&mut *conn)
            .await?;
    if raw.is_none()
        && sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM teaching_closures WHERE user_id=? AND id=?",
        )
        .bind(&actor.user_id)
        .bind(id)
        .fetch_one(&mut *conn)
        .await?
            > 0
    {
        return Err(ApiError::new(410, "该录制请求已关闭。").with_code("TEACHING_CLOSED"));
    }
    decode(&raw.ok_or_else(|| ApiError::new(404, "教学记录不存在。"))?)
}
pub async fn save(conn: &mut SqliteConnection, value: &Value) -> Result<()> {
    let raw = value.to_string();
    if raw.len() > 65536 {
        return Err(ApiError::new(413, "教学记录过大，请精简步骤。"));
    }
    sqlx::query("INSERT INTO teaching_sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(value["id"].as_str()).bind(value["userId"].as_str()).bind(value["agentId"].as_str()).bind(raw).execute(conn).await?;
    Ok(())
}
pub fn stamp(value: &mut Value) {
    value["revision"] = json!(uuid::Uuid::new_v4().to_string());
    value["updatedAt"] = json!(iso(now()));
}
pub fn public(value: &Value) -> Value {
    let mut copy = value.clone();
    if let Some(object) = copy.as_object_mut() {
        for key in ["userId", "sessionId", "leaseId", "agentRevision"] {
            object.remove(key);
        }
    }
    copy
}
pub async fn subject(
    conn: &mut SqliteConnection,
    agent: &str,
    conversation: &str,
) -> Result<Value> {
    let bot = WorkspaceStore::get_in(conn, Table::Agents, agent)
        .await?
        .ok_or_else(|| ApiError::new(404, "Bot 不存在。"))?;
    if bot.get("sharedBot").is_some() {
        return Err(ApiError::new(403, "共享 Bot 的技能由来源拥有者管理。"));
    }
    let chat = WorkspaceStore::get_in(conn, Table::Conversations, conversation)
        .await?
        .ok_or_else(|| ApiError::new(404, "会话不存在。"))?;
    if !chat["agentIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == agent))
    {
        return Err(ApiError::new(409, "Bot 已不在原会话中。"));
    }
    Ok(bot)
}
pub fn expected(value: &Value, revision: &Value) -> Result<()> {
    if !revision.is_string() || value["revision"] != *revision {
        return Err(ApiError::new(409, "教学记录已变化，请重新核对。"));
    }
    Ok(())
}

pub fn decode(raw: &str) -> Result<Value> {
    serde_json::from_str(raw).map_err(|_| ApiError::new(500, "教学记录暂不可用。"))
}
