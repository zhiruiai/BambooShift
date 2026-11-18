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
mod tests {
    use super::*;

    #[test]
    fn only_a_matching_attachment_receipt_confirms_dispatch() {
        let payload = json!({"url":"https://creator.example","sha256":"a".repeat(64)});
        let valid = json!({"attached":true,"origin":payload["url"],"sha256":payload["sha256"]});
        let reply = |value: &Value| {
            Ok(super::super::transport::Reply {
                status: 200,
                headers: Default::default(),
                bytes: value.to_string().into_bytes(),
            })
        };
        assert_eq!(attachment_result(reply(&valid), &payload).unwrap(), valid);
        for key in ["attached", "origin", "sha256"] {
            let mut invalid = valid.clone();
            invalid[key] = Value::Null;
            assert_eq!(
                attachment_result(reply(&invalid), &payload)
                    .unwrap_err()
                    .status,
                502
            );
        }
        let offline = ApiError::new(502, "连接中断");
        assert!(
            attachment_result(Err(offline), &payload)
                .unwrap_err()
                .message
                .contains("可能已经")
        );
        let denied = ApiError::new(403, "已拒绝");
        assert_eq!(
            attachment_result(Err(denied), &payload).unwrap_err().status,
            403
        );
    }

    #[test]
    fn completed_upload_is_bound_to_the_requester_chat_bot_and_target_revision() {
        let revision = json!(uuid::Uuid::new_v4().to_string());
        let context = ActionContext {
            conversation_id: Some("chat".into()),
            agent_id: Some("bot".into()),
            requester: Some(json!({"userId":"owner"})),
            ..Default::default()
        };
        let payload = json!({"fileId":"image-1","path":"images/cover.png","sha256":"a".repeat(64)});
        let record = json!({"context":context,"action":{
            "requester":{"userId":"owner"},"execution":{"targetRevision":revision},
            "type":"upload_file","status":"done","payload":payload,"result":{"path":payload["path"],"sha256":payload["sha256"]}
        }});
        assert_eq!(
            uploaded_file(&record, &context, &revision).unwrap(),
            &payload
        );
        let new_revision = json!(uuid::Uuid::new_v4().to_string());
        assert!(uploaded_file(&record, &context, &new_revision).is_err());
        for (path, value) in [
            ("/action/status", "error"),
            ("/action/status", "pending"),
            ("/action/type", "download_file"),
            ("/action/result/path", "other.png"),
            ("/action/result/sha256", "wrong"),
            ("/context/conversationId", "elsewhere"),
            ("/context/agentId", "another-bot"),
            ("/action/requester/userId", "another-user"),
        ] {
            let mut different = record.clone();
            *different.pointer_mut(path).unwrap() = json!(value);
            assert!(
                uploaded_file(&different, &context, &revision).is_err(),
                "{path}"
            );
        }
    }
}
