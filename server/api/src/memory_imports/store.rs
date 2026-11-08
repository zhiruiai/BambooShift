use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS memory_imports(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,PRIMARY KEY(actor_id,request_id))").execute(&mut *conn).await?;
    let rows = sqlx::query("SELECT rowid,data FROM memory_imports")
        .fetch_all(&mut *conn)
        .await?;
    for row in rows {
        let mut receipt: Value = serde_json::from_str(row.get("data")).map_err(|_| invalid())?;
        if receipt.get("status").is_none() {
            migrate_status(conn, &mut receipt).await?;
        } else if ["queued", "delivered", "running"]
            .contains(&receipt["status"].as_str().unwrap_or(""))
        {
            // The intentionally non-persistent source cannot be replayed after a restart.
            receipt["status"] = json!("interrupted");
        } else {
            continue;
        }
        sqlx::query("UPDATE memory_imports SET data=? WHERE rowid=?")
            .bind(receipt.to_string())
            .bind(row.get::<i64, _>("rowid"))
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}
async fn migrate_status(conn: &mut SqliteConnection, receipt: &mut Value) -> Result<()> {
    receipt["status"] = json!("interrupted");
    let Some(input) = WorkspaceStore::get_in(
        conn,
        Table::Messages,
        receipt["messageId"].as_str().unwrap_or(""),
    )
    .await?
    else {
        return Ok(());
    };
    if input["conversationId"] != receipt["conversationId"]
        || input["role"] != "user"
        || input["userId"] != receipt["userId"]
        || input["delivery"]["clientId"] != receipt["requestId"]
        || input["delivery"]["agentId"] != receipt["agentId"]
        || input["metadata"]["memoryImport"]["id"] != receipt["requestId"]
    {
        return Ok(());
    }
    if ["cancelled", "interrupted"].contains(&input["delivery"]["state"].as_str().unwrap_or("")) {
        receipt["status"] = input["delivery"]["state"].clone();
        return Ok(());
    }
    let output = WorkspaceStore::list_in(conn, Table::Messages)
        .await?
        .into_iter()
        .filter(|m| {
            m["role"] == "assistant"
                && m["conversationId"] == receipt["conversationId"]
                && m["agentId"] == receipt["agentId"]
                && m["metadata"]["memoryImport"]["inputMessageId"] == receipt["messageId"]
                && m["metadata"]["memoryImport"]["requestId"] == receipt["requestId"]
        })
        .last();
    if let Some(output) = output {
        if output["status"] == "done" || output["status"] == "error" {
            receipt["status"] = json!(if output["status"] == "done" {
                "completed"
            } else {
                "error"
            });
            receipt["resultMessageId"] = output["id"].clone();
        }
    }
    Ok(())
}
fn invalid() -> ApiError {
    ApiError::new(409, "原导入回执不可用，请先核对主 Bot 会话，不要重复提交。")
        .with_code("MEMORY_IMPORT_RECEIPT_INVALID")
}
pub(super) fn request_id(value: &Value) -> Result<String> {
    let text = value
        .as_str()
        .ok_or_else(|| ApiError::bad("导入请求标识无效。"))?;
    if uuid::Uuid::parse_str(text)
        .ok()
        .is_none_or(|id| id.to_string() != text)
    {
        return Err(ApiError::bad("导入请求标识无效。"));
    }
    Ok(text.to_owned())
}
pub(super) fn digest(revision: &str, content: &str) -> String {
    // This key order matches the original Node service's persisted digest.
    let bytes = format!(
        "{{\"expectedPrimaryRevision\":{},\"content\":{}}}",
        json!(revision),
        json!(content)
    );
    format!("{:x}", Sha256::digest(bytes.as_bytes()))
}
pub(super) async fn saved(
    conn: &mut SqliteConnection,
    grant: &WorkspaceAccess,
    id: &str,
) -> Result<Option<(String, Value)>> {
    let row = sqlx::query(
        "SELECT digest,data,message_id FROM memory_imports WHERE actor_id=? AND request_id=?",
    )
    .bind(format!("user:{}", grant.user_id))
    .bind(id)
    .fetch_optional(conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let receipt: Value = serde_json::from_str(row.get("data")).map_err(|_| invalid())?;
    if receipt["requestId"] != id
        || receipt["userId"] != grant.user_id
        || receipt["workspaceId"] != grant.workspace_id
        || receipt["messageId"] != row.get::<String, _>("message_id")
        || receipt["agentId"].as_str().is_none()
        || receipt["conversationId"].as_str().is_none()
        || receipt["primaryRevision"].as_str().is_none()
    {
        return Err(invalid());
    }
    Ok(Some((row.get("digest"), receipt)))
}
pub(super) async fn view(conn: &mut SqliteConnection, mut receipt: Value) -> Result<Value> {
    let agent = WorkspaceStore::get_in(
        conn,
        Table::Agents,
        receipt["agentId"].as_str().unwrap_or(""),
    )
    .await?;
    let chat = WorkspaceStore::get_in(
        conn,
        Table::Conversations,
        receipt["conversationId"].as_str().unwrap_or(""),
    )
    .await?;
    let input = WorkspaceStore::get_in(
        conn,
        Table::Messages,
        receipt["messageId"].as_str().unwrap_or(""),
    )
    .await?;
    let valid = agent.is_some_and(|a| a.get("sharedBot").is_none())
        && chat
            .is_some_and(|c| c["isGroup"] == false && c["agentIds"] == json!([receipt["agentId"]]))
        && input.as_ref().is_some_and(|m| {
            m["role"] == "user"
                && m["userId"] == receipt["userId"]
                && m["conversationId"] == receipt["conversationId"]
                && m["delivery"]["clientId"] == receipt["requestId"]
                && m["delivery"]["agentId"] == receipt["agentId"]
                && m["metadata"]["memoryImport"]["id"] == receipt["requestId"]
        });
    if !valid {
        receipt["status"] = json!("missing");
        return Ok(receipt);
    }
    if ["queued", "delivered", "running"].contains(&receipt["status"].as_str().unwrap_or("")) {
        let input = input.unwrap();
        let state = input["delivery"]["state"].as_str().unwrap_or("");
        if ["cancelled", "interrupted"].contains(&state) {
            receipt["status"] = json!(state);
        } else if state == "delivered" {
            receipt["status"] = json!("running");
        }
    }
    Ok(receipt)
}
pub async fn settle(conn: &mut SqliteConnection, input: &Value, result: &Value) -> Result<()> {
    let Some(id) = input["metadata"]["memoryImport"]["id"].as_str() else {
        return Ok(());
    };
    let actor = format!("user:{}", input["userId"].as_str().unwrap_or(""));
    let row = sqlx::query("SELECT data FROM memory_imports WHERE actor_id=? AND request_id=?")
        .bind(&actor)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(()) };
    let mut receipt: Value = serde_json::from_str(row.get("data")).map_err(|_| invalid())?;
    if !["queued", "delivered", "running"].contains(&receipt["status"].as_str().unwrap_or("")) {
        return Ok(());
    }
    let marker = &result["metadata"]["memoryImport"];
    if result["role"] != "assistant"
        || result["agentId"] != receipt["agentId"]
        || result["conversationId"] != receipt["conversationId"]
        || result["metadata"]["inputMessageId"] != input["id"]
        || receipt["messageId"] != input["id"]
        || marker["id"] != id
    {
        return Err(invalid());
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
        return Err(invalid());
    }
    receipt["status"] = json!(status);
    receipt["resultMessageId"] = result["id"].clone();
    sqlx::query("UPDATE memory_imports SET data=? WHERE actor_id=? AND request_id=?")
        .bind(receipt.to_string())
        .bind(actor)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
