use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(crate) fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub(crate) async fn reply(
    conn: &mut SqliteConnection,
    cid: &str,
    id: &Value,
    thread: Option<&str>,
) -> Result<Option<Value>> {
    if id.is_null() {
        return Ok(None);
    }
    let id = id
        .as_str()
        .filter(|s| opaque(s))
        .ok_or_else(|| ApiError::bad("请选择有效的原消息。"))?;
    let original = WorkspaceStore::get_in(conn, Table::Messages, id)
        .await?
        .ok_or_else(|| {
            if thread.is_some() {
                super::threads::unavailable()
            } else {
                ApiError::new(404, "原消息不存在，请取消引用后重试。")
            }
        })?;
    if original["conversationId"] != cid {
        return Err(if thread.is_some() {
            super::threads::unavailable()
        } else {
            ApiError::bad("只能回复当前会话中的消息。")
        });
    }
    if thread != Some(id) && !super::threads::belongs(&original, thread) {
        return Err(super::threads::unavailable());
    }
    let bot = if let Some(id) = original["agentId"].as_str() {
        WorkspaceStore::get_in(conn, Table::Agents, id).await?
    } else {
        None
    };
    let author = if original["role"] == "user" {
        original["metadata"]["author"]["name"]
            .as_str()
            .unwrap_or("用户")
    } else {
        bot.as_ref()
            .and_then(|b| b["name"].as_str())
            .or_else(|| original["metadata"]["author"]["name"].as_str())
            .unwrap_or(if original["role"] == "assistant" {
                "Bot"
            } else {
                "系统"
            })
    };
    let content = original["content"].as_str().unwrap_or("");
    let excerpt = content.chars().take(2000).collect::<String>();
    Ok(Some(
        json!({"id":id,"agentId":original["agentId"],"author":author,"content":if excerpt.len()<content.len(){format!("{excerpt}…")}else{excerpt},"kind":original["kind"]}),
    ))
}
pub async fn react(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    only_fields(&body, &["emoji", "active"])?;
    let emoji = body["emoji"]
        .as_str()
        .filter(|e| ["👍", "❤️", "🎉", "👀", "✅"].contains(e))
        .ok_or_else(|| ApiError::bad("请选择有效的消息回应。"))?;
    let enabled = body["active"]
        .as_bool()
        .ok_or_else(|| ApiError::bad("请选择回应状态。"))?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let mut message = WorkspaceStore::get_in(&mut tx, Table::Messages, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "消息不存在。"))?;
    if !message["reactionMembers"].is_object() {
        message["reactionMembers"] = json!({});
    }
    let mut members = message["reactionMembers"][emoji]
        .as_array()
        .cloned()
        .unwrap_or_default();
    members.retain(|user| user != &grant.user_id);
    if enabled {
        members.push(json!(grant.user_id));
    }
    let mut reactions = message["reactions"].as_array().cloned().unwrap_or_default();
    reactions.retain(|e| e != emoji);
    if members.is_empty() {
        message["reactionMembers"]
            .as_object_mut()
            .unwrap()
            .remove(emoji);
    } else {
        message["reactionMembers"][emoji] = json!(members);
        reactions.push(json!(emoji));
    }
    message["reactions"] = json!(reactions);
    WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("message", message.clone());
    Ok(Json(message))
}
