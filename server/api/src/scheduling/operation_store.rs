use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};

pub(crate) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    for query in [
        "CREATE TABLE IF NOT EXISTS routine_operations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(actor_id,request_id))",
        "CREATE TABLE IF NOT EXISTS routine_operation_cancellations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(actor_id,request_id))",
    ] {
        sqlx::query(query).execute(&mut *conn).await?;
    }
    let rows = sqlx::query("SELECT actor_id,request_id,data FROM routine_operations")
        .fetch_all(&mut *conn)
        .await?;
    for row in rows {
        let mut value: Value =
            serde_json::from_str(row.get("data")).map_err(|_| invalid_receipt())?;
        if value["kind"] == "run" && value["status"] == "submitted" {
            value["status"] = json!("interrupted");
            sqlx::query("UPDATE routine_operations SET data=? WHERE actor_id=? AND request_id=?")
                .bind(value.to_string())
                .bind(row.get::<String, _>("actor_id"))
                .bind(row.get::<String, _>("request_id"))
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}
pub(crate) fn request_id(value: &Value) -> Result<String> {
    let text = value
        .as_str()
        .ok_or_else(|| ApiError::bad("请求标识无效。"))?;
    if uuid::Uuid::parse_str(text)
        .ok()
        .is_none_or(|id| id.to_string() != text)
    {
        return Err(ApiError::bad("请求标识无效。"));
    }
    Ok(text.to_owned())
}
pub(crate) fn digest(value: &Value) -> Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| ApiError::bad("请求格式无效。"))?;
    if bytes.len() > 65536 {
        return Err(ApiError::new(413, "请求内容过大。"));
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub(crate) fn actor(grant: &WorkspaceAccess) -> String {
    format!("user:{}", grant.user_id)
}
fn invalid_receipt() -> ApiError {
    ApiError::new(409, "原回执不可用，请核对任务与聊天记录，不要重复提交。")
        .with_code("ROUTINE_OPERATION_RECEIPT_INVALID")
}
pub(crate) async fn saved(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    id: &str,
) -> Result<Option<(String, Value)>> {
    let row =
        sqlx::query("SELECT digest,data FROM routine_operations WHERE actor_id=? AND request_id=?")
            .bind(actor(grant))
            .bind(id)
            .fetch_optional(conn)
            .await?;
    let Some(row) = row else { return Ok(None) };
    let value: Value = serde_json::from_str(row.get("data")).map_err(|_| invalid_receipt())?;
    if value["requestId"] != id
        || value["userId"] != grant.user_id
        || value["workspaceId"] != grant.workspace_id
        || !["create", "run"].contains(&value["kind"].as_str().unwrap_or(""))
        || value["routineId"].as_str().is_none()
        || value["agentId"].as_str().is_none()
        || value["conversationId"].as_str().is_none()
    {
        return Err(invalid_receipt());
    }
    Ok(Some((row.get("digest"), value)))
}
pub(crate) async fn closed(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    id: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM routine_operation_cancellations WHERE actor_id=? AND request_id=?",
    )
    .bind(actor(grant))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .is_some())
}
pub(crate) async fn assert_open(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    id: &str,
) -> Result<()> {
    if closed(conn, grant, id).await? {
        return Err(
            ApiError::new(409, "这次未接纳的请求已结束，请明确创建新的请求。")
                .with_code("ROUTINE_OPERATION_CLOSED"),
        );
    }
    Ok(())
}
pub(crate) async fn prior(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    id: &str,
    digest: &str,
) -> Result<Option<Value>> {
    let Some((saved_digest, value)) = saved(conn, grant, id).await? else {
        return Ok(None);
    };
    if saved_digest != digest {
        return Err(
            ApiError::new(409, "同一次请求不能用于不同内容，请先核对原提交。")
                .with_code("ROUTINE_OPERATION_CONFLICT"),
        );
    }
    Ok(Some(view(conn, grant, value).await?))
}
pub(crate) async fn view(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    mut value: Value,
) -> Result<Value> {
    let exists = if value["kind"] == "create" {
        WorkspaceStore::get_in(
            conn,
            Table::Routines,
            value["routineId"].as_str().unwrap_or(""),
        )
        .await?
        .is_some()
    } else {
        let input = WorkspaceStore::get_in(
            conn,
            Table::Messages,
            value["messageId"].as_str().unwrap_or(""),
        )
        .await?;
        let chat = WorkspaceStore::get_in(
            conn,
            Table::Conversations,
            value["conversationId"].as_str().unwrap_or(""),
        )
        .await?;
        input.as_ref().is_some_and(|m| {
            m["role"] == "user"
                && m["userId"] == grant.user_id
                && m["conversationId"] == value["conversationId"]
                && m["delivery"]["clientId"] == value["requestId"]
                && m["delivery"]["agentId"] == value["agentId"]
                && m["metadata"]["routineOperation"]["requestId"] == value["requestId"]
                && m["metadata"]["routineOperation"]["routineId"] == value["routineId"]
        }) && chat.is_some()
    };
    if !exists {
        value["status"] = json!("missing");
    }
    Ok(value)
}
pub(crate) async fn insert(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    digest: &str,
    receipt: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO routine_operations(actor_id,request_id,digest,data) VALUES(?,?,?,?)")
        .bind(actor(grant))
        .bind(receipt["requestId"].as_str())
        .bind(digest)
        .bind(receipt.to_string())
        .execute(conn)
        .await?;
    Ok(())
}
pub(crate) async fn settle(
    conn: &mut SqliteConnection,
    input: &Value,
    result: &Value,
) -> Result<()> {
    let Some(id) = input["metadata"]["routineOperation"]["requestId"].as_str() else {
        return Ok(());
    };
    let actor = format!("user:{}", input["userId"].as_str().unwrap_or(""));
    let row = sqlx::query("SELECT data FROM routine_operations WHERE actor_id=? AND request_id=?")
        .bind(&actor)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(()) };
    let mut receipt: Value =
        serde_json::from_str(row.get("data")).map_err(|_| invalid_receipt())?;
    if receipt["status"] != "submitted" {
        return Ok(());
    }
    let run = &result["metadata"]["routineRun"];
    if receipt["messageId"] != input["id"]
        || result["role"] != "assistant"
        || result["conversationId"] != receipt["conversationId"]
        || result["agentId"] != receipt["agentId"]
        || run["inputMessageId"] != input["id"]
        || run["routineId"] != receipt["routineId"]
        || run["runId"] != input["id"]
    {
        return Err(invalid_receipt());
    }
    let status =
        result["metadata"]["executionStatus"]
            .as_str()
            .unwrap_or(if result["status"] == "done" {
                "completed"
            } else {
                "error"
            });
    if !["completed", "error", "cancelled", "interrupted"].contains(&status) {
        return Err(invalid_receipt());
    }
    receipt["status"] = json!(status);
    receipt["resultMessageId"] = result["id"].clone();
    sqlx::query("UPDATE routine_operations SET data=? WHERE actor_id=? AND request_id=?")
        .bind(receipt.to_string())
        .bind(actor)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
