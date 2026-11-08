use super::{apps_tools::authority, authority::ExecutionAccess, tools::ToolContext};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields},
    workspace::{Table, WorkspaceStore, file_edits, file_storage::Directory},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

pub(crate) async fn deliver(
    state: &State,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    context: &ToolContext<'_>,
    args: &Value,
) -> Result<Value> {
    only_fields(args, &["path", "expectedSha256"])?;
    let name = file_edits::path(
        args["path"]
            .as_str()
            .ok_or_else(|| ApiError::bad("请提供工作区相对文件路径。"))?,
    )?;
    let expected = args["expectedSha256"]
        .as_str()
        .filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| ApiError::bad("文件版本摘要无效。"))?
        .to_ascii_lowercase();
    let authorize = authority(state, access, store, context);
    authorize().await?;
    let key = json!([context.active.run_id, name, expected]).to_string();
    let message_id = format!("delivery-{}", hex::encode(Sha256::digest(key.as_bytes())));
    let mut tx = store.begin().await?;
    if let Some(message) = WorkspaceStore::get_in(&mut tx, Table::Messages, &message_id).await? {
        if WorkspaceStore::get_in(
            &mut tx,
            Table::Files,
            message["metadata"]["fileId"].as_str().unwrap_or(""),
        )
        .await?
        .is_none()
        {
            return Err(ApiError::new(409, "文件不存在。"));
        }
        authorize().await?;
        return Ok(result(&message));
    }
    let source: String =
        sqlx::query_scalar("SELECT data FROM files WHERE json_extract(data,'$.name')=? LIMIT 1")
            .bind(&name)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError::new(404, "文件不存在。"))?;
    let source: Value =
        serde_json::from_str(&source).map_err(|_| ApiError::new(409, "文件记录无效。"))?;
    let directory = Directory::open(&store.directory, false)?;
    let mut reader = directory.reader(&name)?;
    if reader.len() > 10 * 1024 * 1024 {
        return Err(ApiError::new(413, "文件最大为 10 MiB。"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reader.next()? {
        bytes.extend(chunk);
    }
    if hex::encode(Sha256::digest(&bytes)) != expected {
        return Err(
            ApiError::new(409, "文件版本已变化，请重新读取；本次未写入。")
                .with_code("FILE_CHANGED"),
        );
    }
    let public_name = Path::new(&name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.chars().any(char::is_control) && name.encode_utf16().count() <= 160)
        .ok_or_else(|| ApiError::bad("文件名称或大小无效。"))?;
    let id = uuid::Uuid::new_v4().to_string();
    // Reuse exclusive file publication so subsequent source edits do not change this delivery.
    let (saved_name, uploaded) = directory.upload(public_name, &bytes, &id)?;
    let file = json!({"id":id,"name":saved_name,"size":bytes.len(),"type":source["type"],
        "createdAt":iso(now()),"conversationId":context.active.conversation_id,
        "source":{"kind":"workspace_delivery","fileId":source["id"],"sha256":expected}});
    let mut message = json!({"id":message_id,"conversationId":context.active.conversation_id,
        "agentId":context.active.agent_id,"role":"assistant","kind":"file","status":"done",
        "content":public_name,"createdAt":file["createdAt"],
        "metadata":{"fileId":id,"name":public_name,"size":bytes.len(),"sha256":expected,
            "runId":context.active.run_id,"inputMessageId":context.input["id"],
            "fileDelivery":{"sourceFileId":source["id"],"toolCallId":context.call_id}}});
    super::threads::stamp(&mut message, context.active.thread_root_id.as_deref());
    WorkspaceStore::put_in(&mut tx, Table::Files, &file).await?;
    WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
    authorize().await?;
    tx.commit().await?;
    uploaded.commit();
    store.emit("message", message.clone());
    store.emit("update", json!({}));
    Ok(result(&message))
}
fn result(message: &Value) -> Value {
    let value = json!({"delivered":true,"messageId":message["id"],"fileId":message["metadata"]["fileId"],
        "name":message["metadata"]["name"],"size":message["metadata"]["size"],"sha256":message["metadata"]["sha256"]});
    json!({"content":[{"type":"text","text":value.to_string()}],"details":value})
}
