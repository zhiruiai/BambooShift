use super::{Table, WorkspaceStore, access};
use crate::{
    db::State,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Deserialize)]
pub struct Options {
    language: Option<String>,
}

pub async fn authorize(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    if store.get(Table::Conversations, &id).await?.is_none() {
        return Err(ApiError::new(404, "Conversation not found."));
    }
    grant.authorize(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    Query(options): Query<Options>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let zh = match options.language.as_deref().unwrap_or("en") {
        "zh-CN" => true,
        "en" => false,
        _ => return Err(ApiError::bad("Unsupported export language.")),
    };
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    // Keep every page, author and attachment in the same SQLite read snapshot.
    let mut tx = store.pool.begin().await?;
    let conversation = WorkspaceStore::get_in(&mut tx, Table::Conversations, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "Conversation not found."))?;
    let agents = WorkspaceStore::list_in(&mut tx, Table::Agents).await?;
    let exported_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut transcript =
        super::conversation_markdown::Transcript::new(&conversation, &exported_at, zh)?;
    let mut cursor = 0_i64;
    loop {
        grant.authorize(&state).await?;
        let rows = sqlx::query("SELECT rowid,data FROM messages WHERE rowid>? AND json_extract(data,'$.conversationId')=? ORDER BY rowid LIMIT 250")
            .bind(cursor).bind(&id).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            cursor = row.get("rowid");
            let message: Value = serde_json::from_str(row.get("data"))
                .map_err(|_| ApiError::new(500, "Conversation data is unavailable."))?;
            let file = if message["kind"] == "file" {
                if let Some(fid) = message["metadata"]["fileId"].as_str() {
                    WorkspaceStore::get_in(&mut tx, Table::Files, fid)
                        .await?
                        .filter(|f| f["conversationId"].is_null() || f["conversationId"] == id)
                } else {
                    None
                }
            } else {
                None
            };
            transcript.push(&message, &agents, file.as_ref())?;
        }
        tokio::task::yield_now().await;
    }
    tx.commit().await?;
    grant.authorize(&state).await?;
    Ok(Json(json!({
        "conversationId": id, "filename": format!("conversation-{}.md", uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad("Invalid conversation."))?),
        "content": transcript.content, "messageCount": transcript.count,
        "exportedAt": exported_at, "complete": true,
    })))
}
