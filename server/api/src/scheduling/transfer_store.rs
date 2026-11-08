use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS routine_transfers(user_id TEXT NOT NULL,request_id TEXT NOT NULL,routine_id TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(user_id,request_id))").execute(&mut *conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS routine_transfer_closures(user_id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(user_id,request_id))").execute(conn).await?;
    Ok(())
}
pub fn identifier(value: &Value) -> Result<String> {
    value
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad("转交请求标识无效。"))
}
pub fn hash(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string()))
}
pub fn conflict() -> ApiError {
    ApiError::new(409, "例行任务或转交目标已变化，请重新核对后确认。")
        .with_code("ROUTINE_TRANSFER_CHANGED")
}
pub fn closed() -> ApiError {
    ApiError::new(410, "这次未接纳的转交请求已经结束。").with_code("ROUTINE_TRANSFER_CLOSED")
}
pub async fn receipt(
    conn: &mut SqliteConnection,
    actor: &WorkspaceAccess,
    id: &str,
) -> Result<Option<Value>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT data FROM routine_transfers WHERE user_id=? AND request_id=?")
            .bind(&actor.user_id)
            .bind(id)
            .fetch_optional(conn)
            .await?;
    raw.map(|text| {
        serde_json::from_str(&text).map_err(|_| ApiError::new(500, "转交回执暂不可用。"))
    })
    .transpose()
}
pub async fn view(conn: &mut SqliteConnection, mut saved: Value) -> Result<Value> {
    let id = saved["routineId"].as_str().unwrap_or("");
    if let Some(routine) = WorkspaceStore::get_in(conn, Table::Routines, id).await? {
        saved["status"] = json!("transferred");
        saved["routine"] = routine;
    } else {
        saved["status"] = json!("missing");
    }
    Ok(saved)
}
pub async fn replay(
    conn: &mut SqliteConnection,
    actor: &WorkspaceAccess,
    id: &str,
    routine: &str,
    digest: &str,
) -> Result<Option<Value>> {
    if let Some(saved) = receipt(conn, actor, id).await? {
        let original: String = sqlx::query_scalar(
            "SELECT digest FROM routine_transfers WHERE user_id=? AND request_id=?",
        )
        .bind(&actor.user_id)
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
        if saved["routineId"] != routine || original != digest {
            return Err(conflict());
        }
        return Ok(Some(view(conn, saved).await?));
    }
    Ok(None)
}
pub async fn is_closed(
    conn: &mut SqliteConnection,
    actor: &WorkspaceAccess,
    id: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM routine_transfer_closures WHERE user_id=? AND request_id=?",
    )
    .bind(&actor.user_id)
    .bind(id)
    .fetch_optional(conn)
    .await?
    .is_some())
}
/// A personal transfer never resolves another member's private chat or creates a destination.
pub async fn direct_target(
    conn: &mut SqliteConnection,
    agent: &str,
    conversation: &str,
) -> Result<()> {
    let (bot, chat) = super::routines::target(conn, agent, conversation).await?;
    if bot.get("sharedBot").is_some() {
        return Err(ApiError::new(
            403,
            "只能在自己的本地 Bot 之间转交例行任务。",
        ));
    }
    if chat["isGroup"] != false || chat["agentIds"] != json!([agent]) {
        return Err(conflict());
    }
    let matches = WorkspaceStore::list_in(conn, Table::Conversations)
        .await?
        .into_iter()
        .filter(|c| c["isGroup"] == false && c["agentIds"] == json!([agent]))
        .count();
    if matches != 1 {
        return Err(ApiError::new(
            409,
            "目标需要唯一且有效的单人会话，请先核对会话。",
        ));
    }
    Ok(())
}
