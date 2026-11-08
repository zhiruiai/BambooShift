use super::{
    apps_tools::authority, authority::ExecutionAccess, registry::ActiveRun, tools::ToolContext,
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields, text},
    speech::memo_synthesis::{self, SynthesizedMemo},
    workspace::{Table, WorkspaceAccess, WorkspaceStore, file_storage::Directory},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::{sync::Arc, time::Duration};

pub(super) const TOOL: &str = "send_voice_memo";

fn invalid() -> ApiError {
    ApiError::bad("请选择用语音回复的独立消息。").with_code("VOICE_MEMO_INVALID")
}

fn out_of_scope() -> ApiError {
    ApiError::new(403, "语音便笺适用于你个人空间里的本地 Bot 单聊。").with_code("VOICE_MEMO_SCOPE")
}

pub(super) fn unavailable() -> ApiError {
    ApiError::new(409, "语音便笺暂不可用，请检查模型或工作空间服务。")
        .with_code("VOICE_MEMO_UNAVAILABLE")
}

pub(super) fn requested(body: &Value, mode: &str) -> Result<bool> {
    let Some(flag) = body.get("requestVoiceMemo") else {
        return Ok(false);
    };
    if flag != true
        || mode != "followUp"
        || [
            "agentId",
            "replyToMessageId",
            "threadRootId",
            "appContext",
            "mentions",
            "voiceCallId",
        ]
        .iter()
        .any(|key| body.get(key).is_some())
    {
        return Err(invalid());
    }
    Ok(true)
}

fn direct(chat: &Value, agent_id: &Value) -> bool {
    agent_id.is_string()
        && chat["isGroup"] != true
        && chat["demo"] != true
        && chat["agentIds"]
            .as_array()
            .is_some_and(|agents| agents.len() == 1 && &agents[0] == agent_id)
}

fn personal(actor: &WorkspaceAccess) -> bool {
    actor.kind == "personal" && actor.is_owner
}

pub(super) async fn authorize_submission(
    state: &State,
    actor: &WorkspaceAccess,
    chat: &Value,
    agent: &Value,
) -> Result<()> {
    if !personal(actor) || !direct(chat, &agent["id"]) || agent.get("sharedBot").is_some() {
        return Err(out_of_scope());
    }
    actor.authorize_owner(state).await?;
    if !memo_synthesis::available(&state.config.data_dir) {
        return Err(unavailable());
    }
    Ok(())
}

fn run_allowed(access: &ExecutionAccess, active: &ActiveRun) -> bool {
    matches!(access, ExecutionAccess::User(actor) if personal(actor))
        && active.kind == "user"
        && active.depth == 0
        && active.thread_root_id.is_none()
        && active.family.voice_memo.get().is_some()
}

pub(super) fn offer(
    state: &State,
    access: &ExecutionAccess,
    active: &ActiveRun,
    chat: &Value,
    definitions: &mut Value,
    system: &mut String,
) {
    if !run_allowed(access, active) || !direct(chat, &json!(active.agent_id)) {
        return;
    }
    if !memo_synthesis::available(&state.config.data_dir) {
        system.push_str("\nThe user requested a voice memo but this workspace's voice memo engine is currently unavailable. Provide a concise text reply and report that audio could not be delivered.");
        return;
    }
    definitions.as_array_mut().unwrap().push(json!({
        "name":TOOL,
        "description":"Send the requested reply as a playable voice memo with its exact text transcript. This direct user request authorizes one voice memo. A repeat returns the original delivery.",
        "parameters":{"type":"object","additionalProperties":false,
            "properties":{"transcript":{"type":"string","minLength":1,"maxLength":memo_synthesis::MAX_TEXT_UNITS},
                "locale":{"type":"string","enum":["zh-CN","en-US"]}},
            "required":["transcript","locale"]}
    }));
    system.push_str("\nThe human selected a voice reply for this message. After completing the requested work, use send_voice_memo to deliver your concise, plain spoken answer in the user's language. Use Chinese or English. The transcript should be the words to speak, with no Markdown or voice control directives. Send one memo and avoid repeating its full text in a separate reply. If the tool fails, give a concise text answer and report that audio was not delivered.");
}

async fn validate_current(
    conn: &mut SqliteConnection,
    active: &ActiveRun,
    input: &Value,
) -> Result<()> {
    let chat = WorkspaceStore::get_in(conn, Table::Conversations, &active.conversation_id)
        .await?
        .ok_or_else(out_of_scope)?;
    let agent = WorkspaceStore::get_in(conn, Table::Agents, &active.agent_id)
        .await?
        .ok_or_else(out_of_scope)?;
    let request = WorkspaceStore::get_in(conn, Table::Messages, &active.message_id)
        .await?
        .ok_or_else(out_of_scope)?;
    if !direct(&chat, &agent["id"])
        || agent.get("sharedBot").is_some()
        || request["role"] != "user"
        || request["userId"] != active.user_id
        || request["conversationId"] != active.conversation_id
        || request["delivery"]["runId"] != active.run_id
        || request["metadata"]["requestVoiceMemo"] != true
        || input["id"] != request["id"]
    {
        return Err(out_of_scope());
    }
    Ok(())
}

fn receipt(message: &Value) -> Value {
    let details = json!({"delivered":true,"messageId":message["id"],
        "fileId":message["metadata"]["fileId"],"durationMs":message["metadata"]["voiceMemo"]["durationMs"]});
    json!({"content":[{"type":"text","text":details.to_string()}],"details":details})
}

async fn prior_delivery(conn: &mut SqliteConnection, message_id: &str) -> Result<Option<Value>> {
    let Some(message) = WorkspaceStore::get_in(conn, Table::Messages, message_id).await? else {
        return Ok(None);
    };
    let id = message["metadata"]["fileId"].as_str().unwrap_or("");
    if WorkspaceStore::get_in(conn, Table::Files, id)
        .await?
        .is_none()
    {
        return Err(ApiError::new(409, "这条语音便笺的音频已删除。"));
    }
    Ok(Some(receipt(&message)))
}

pub(super) async fn execute(
    state: &State,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    context: &ToolContext<'_>,
    args: &Value,
) -> Result<Value> {
    if !run_allowed(access, context.active) || context.input["metadata"]["requestVoiceMemo"] != true
    {
        return Err(out_of_scope());
    }
    let actor = access.as_user().cloned().ok_or_else(out_of_scope)?;
    let authorize = authority(state, access, store, context);
    authorize().await?;
    actor.authorize_owner(state).await?;
    let message_id = format!("voice-memo-{}", context.active.message_id);
    {
        let mut conn = store.pool.acquire().await?;
        validate_current(&mut conn, context.active, context.input).await?;
        if let Some(delivery) = prior_delivery(&mut conn, &message_id).await? {
            authorize().await?;
            actor.authorize_owner(state).await?;
            return Ok(delivery);
        }
    }
    only_fields(args, &["transcript", "locale"])?;
    let transcript = text(
        &args["transcript"],
        "语音便笺文字稿",
        memo_synthesis::MAX_TEXT_UNITS,
    )?;
    let locale = args["locale"].as_str().ok_or_else(invalid)?;
    let memo = {
        let synthesis = memo_synthesis::synthesize(&state.config.data_dir, &transcript, locale);
        tokio::pin!(synthesis);
        let mut check = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                result = &mut synthesis => break result?,
                _ = check.tick() => {
                    authorize().await?;
                    actor.authorize_owner(state).await?;
                }
            }
        }
    };
    let (state, store, active, input) = (
        state.clone(),
        store.clone(),
        context.active.clone(),
        context.input.clone(),
    );
    // Complete the database and file commit as one operation even if the Pi caller is dropped.
    tokio::spawn(async move {
        let mut tx = store.begin().await?;
        validate_current(&mut tx, &active, &input).await?;
        if let Some(delivery) = prior_delivery(&mut tx, &message_id).await? {
            authorize().await?;
            actor.authorize_owner(&state).await?;
            return Ok(delivery);
        }
        let SynthesizedMemo { bytes, duration_ms } = memo;
        let id = uuid::Uuid::new_v4().to_string();
        let sha256 = hex::encode(Sha256::digest(&bytes));
        let display_name = "voice-memo.wav";
        let name = format!("{id}-{display_name}");
        let (saved, uploaded) = Directory::open(&store.directory, true)?.upload(&name, &bytes, &id)?;
        let file = json!({"id":id,"name":saved,"type":"audio/wav","size":bytes.len(),"sha256":sha256,
            "createdAt":iso(now()),"conversationId":active.conversation_id,"source":{"kind":"voice_memo"}});
        let message = json!({"id":message_id,"conversationId":active.conversation_id,"agentId":active.agent_id,
            "role":"assistant","kind":"file","status":"done","content":transcript,"createdAt":file["createdAt"],
            "metadata":{"fileId":id,"name":file["name"],"size":bytes.len(),"sha256":sha256,
                "runId":active.run_id,"inputMessageId":input["id"],
                "voiceMemo":{"transcript":transcript,"durationMs":duration_ms}}});
        WorkspaceStore::put_in(&mut tx, Table::Files, &file).await?;
        WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        authorize().await?;
        actor.authorize_owner(&state).await?;
        tx.commit().await?;
        uploaded.commit();
        store.emit("message", message.clone());
        store.emit("update", json!({}));
        Ok(receipt(&message))
    })
    .await
    .map_err(|_| ApiError::new(503, "语音便笺结果暂未确认，请查看聊天记录。"))?
}

pub(super) async fn ensure_file_editable(conn: &mut SqliteConnection, name: &str) -> Result<()> {
    let protected: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM files WHERE json_extract(data,'$.name')=?
         AND json_extract(data,'$.source.kind')='voice_memo')",
    )
    .bind(name)
    .fetch_one(conn)
    .await?;
    if protected {
        return Err(ApiError::new(409, "语音便笺的原始音频不能由 Bot 修改。")
            .with_code("VOICE_MEMO_FILE_IMMUTABLE"));
    }
    Ok(())
}
