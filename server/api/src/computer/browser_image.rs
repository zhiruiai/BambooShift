use super::{action_store, approvals::ActionContext, model};
use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};

fn invalid() -> ApiError {
    ApiError::new(
        409,
        "请选择此会话中由当前用户提供、已向该 Bot 的当前电脑成功上传的图片回执。",
    )
}

fn uploaded_file<'a>(
    record: &'a Value,
    context: &ActionContext,
    revision: &Value,
) -> Result<&'a Value> {
    let conversation = context.conversation_id.as_deref().ok_or_else(invalid)?;
    let agent = context.agent_id.as_deref().ok_or_else(invalid)?;
    let requester = context
        .requester
        .as_ref()
        .and_then(|r| r["userId"].as_str())
        .ok_or_else(invalid)?;
    let action = &record["action"];
    let source = &action["payload"];
    if record["context"]["conversationId"] != conversation
        || record["context"]["agentId"] != agent
        || action["requester"]["userId"] != requester
        || !revision.as_str().is_some_and(model::uuid)
        || action["execution"]["targetRevision"] != *revision
        || action["type"] != "upload_file"
        || action["status"] != "done"
        || !source["fileId"].as_str().is_some_and(model::opaque)
        || !source["path"].is_string()
        || !source["sha256"].is_string()
        || action["result"]["path"] != source["path"]
        || action["result"]["sha256"] != source["sha256"]
    {
        return Err(invalid());
    }
    Ok(source)
}

pub(super) async fn source(
    store: &WorkspaceStore,
    payload: &Value,
    context: &ActionContext,
    revision: &Value,
) -> Result<Value> {
    let id = payload["uploadActionId"]
        .as_str()
        .filter(|id| model::uuid(id))
        .ok_or_else(invalid)?;
    let record = action_store::raw(store, id).await.map_err(|error| {
        if error.status == 404 {
            invalid()
        } else {
            error
        }
    })?;
    let upload = uploaded_file(&record, context, revision)?;
    let file_id = upload["fileId"].as_str().ok_or_else(invalid)?;
    let user = context
        .requester
        .as_ref()
        .and_then(|r| r["userId"].as_str())
        .ok_or_else(invalid)?;
    let conversation = context.conversation_id.as_deref().ok_or_else(invalid)?;
    let file = store
        .get(Table::Files, file_id)
        .await?
        .filter(|file| {
            file["conversationId"] == conversation && file["name"] == upload["sourceName"]
        })
        .ok_or_else(invalid)?;
    // A user's actual upload creates a file message. A Bot-delivered file or a
    // workspace file that happens to share the same filename cannot authorize egress.
    let owned: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE json_extract(data,'$.conversationId')=? AND json_extract(data,'$.role')='user' AND json_extract(data,'$.kind')='file' AND json_extract(data,'$.userId')=? AND json_extract(data,'$.metadata.fileId')=?)")
        .bind(conversation).bind(user).bind(file_id).fetch_one(&store.pool).await?;
    if owned != 1 {
        return Err(invalid());
    }
    Ok(
        json!({"fileId":file_id, "sourceName":file["name"], "path":upload["path"], "sha256":upload["sha256"]}),
    )
}

pub(super) const UNKNOWN: &str = "BROWSER_IMAGE_ATTACHMENT_UNKNOWN";

pub(super) fn unknown() -> ApiError {
    ApiError::new(
        502,
        "网页可能已经收到图片，回执未确认。请先检查原标签页的缩略图和草稿，避免重复上传。",
    )
    .with_code(UNKNOWN)
}

pub(super) fn attachment_result(
    response: Result<super::transport::Reply>,
    payload: &Value,
) -> Result<Value> {
    let response = response.map_err(|error| {
        if error.status.is_server_error() {
            unknown()
        } else {
            error
        }
    })?;
    let value = response.json().map_err(|_| unknown())?;
    if value["attached"] != true
        || value["origin"] != payload["url"]
        || value["sha256"] != payload["sha256"]
    {
        return Err(unknown());
    }
    Ok(value)
}

#[cfg(test)]
#[path = "../../tests/unit/computer/browser_image.rs"]
mod tests;
