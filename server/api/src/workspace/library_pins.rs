use super::{Table, WorkspaceStore, access, library_links};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::collections::{HashMap, HashSet};

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS library_pins (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('website','file','link')),
            target TEXT NOT NULL,
            pinned_at TEXT NOT NULL,
            link_message_id TEXT,
            UNIQUE(actor_id,conversation_id,kind,target))",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS library_pins_conversation ON library_pins(conversation_id)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS library_website_delivery ON messages(
           json_extract(data,'$.conversationId'),json_extract(data,'$.metadata.websiteProject.projectKey'))
         WHERE json_extract(data,'$.kind')='website_project' AND json_extract(data,'$.role')='assistant'",
    )
    .execute(conn)
    .await?;
    Ok(())
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Website,
    File,
    Link,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Website => "website",
            Self::File => "file",
            Self::Link => "link",
        }
    }
    fn target(self, raw: &str) -> Option<String> {
        match self {
            Self::Website
                if raw.len() == 64
                    && raw
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
            {
                Some(raw.to_owned())
            }
            Self::File if opaque(raw) => Some(raw.to_owned()),
            Self::Link => library_links::normalize(raw),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinRequest {
    kind: Kind,
    target: String,
    pinned: bool,
    message_id: Option<String>,
}

fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

async fn require_conversation(conn: &mut SqliteConnection, cid: &str) -> Result<()> {
    WorkspaceStore::get_in(conn, Table::Conversations, cid)
        .await?
        .map(|_| ())
        .ok_or_else(|| ApiError::new(404, "会话不存在。"))
}

async fn website_exists(conn: &mut SqliteConnection, cid: &str, project_key: &str) -> Result<bool> {
    let found = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM messages AS m
         JOIN website_projects AS p ON p.id=json_extract(m.data,'$.metadata.websiteProject.id')
         WHERE json_extract(m.data,'$.conversationId')=?
           AND json_extract(m.data,'$.metadata.websiteProject.projectKey')=?
           AND json_extract(m.data,'$.kind')='website_project' AND json_extract(m.data,'$.role')='assistant'
           AND json_extract(p.manifest,'$.projectKey')=? LIMIT 1",
    )
    .bind(cid)
    .bind(project_key)
    .bind(project_key)
    .fetch_optional(conn)
    .await?;
    Ok(found.is_some())
}

async fn file_exists(conn: &mut SqliteConnection, cid: &str, id: &str) -> Result<bool> {
    Ok(WorkspaceStore::get_in(conn, Table::Files, id)
        .await?
        .is_some_and(|file| {
            file["conversationId"].is_null()
                || file["conversationId"] == ""
                || file["conversationId"] == cid
        }))
}

async fn links(conn: &mut SqliteConnection, cid: &str, message: &str) -> Result<HashSet<String>> {
    let value = WorkspaceStore::get_in(conn, Table::Messages, message).await?;
    Ok(value
        .filter(|value| value["conversationId"] == cid)
        .map(|value| library_links::message_targets(&value))
        .unwrap_or_default())
}

async fn pins(conn: &mut SqliteConnection, cid: &str, actor: &str) -> Result<Value> {
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        "SELECT kind,target,pinned_at,link_message_id FROM library_pins
         WHERE actor_id=? AND conversation_id=? ORDER BY sequence DESC",
    )
    .bind(actor)
    .bind(cid)
    .fetch_all(&mut *conn)
    .await?;
    let mut message_cache = HashMap::new();
    let mut pins = Vec::new();
    for (kind, target, pinned_at, message_id) in rows {
        let present = match (kind.as_str(), message_id) {
            ("website", None) => website_exists(conn, cid, &target).await?,
            ("file", None) => file_exists(conn, cid, &target).await?,
            ("link", Some(id)) => {
                if !message_cache.contains_key(&id) {
                    message_cache.insert(id.clone(), links(conn, cid, &id).await?);
                }
                message_cache[&id].contains(&target)
            }
            _ => false,
        };
        if present {
            pins.push(json!({"kind":kind,"target":target,"pinnedAt":pinned_at}));
        }
    }
    Ok(json!({"pins":pins}))
}

pub(super) async fn get(
    Extract(state): Extract<State>,
    Path((wid, cid)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.pool.begin().await?;
    require_conversation(&mut tx, &cid).await?;
    let output = pins(&mut tx, &cid, &grant.user_id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    Ok(Json(output))
}

pub(super) async fn put(
    Extract(state): Extract<State>,
    Path((wid, cid)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let invalid = || ApiError::bad("请选择有效的资料库条目。");
    let input: PinRequest = serde_json::from_value(body).map_err(|_| invalid())?;
    let target = input.kind.target(&input.target).ok_or_else(invalid)?;
    if input
        .message_id
        .as_deref()
        .is_some_and(|id| !opaque(id) || !matches!(input.kind, Kind::Link))
        || (input.pinned && matches!(input.kind, Kind::Link) && input.message_id.is_none())
    {
        return Err(invalid());
    }
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    require_conversation(&mut tx, &cid).await?;
    let kind = input.kind.name();
    let changed = if input.pinned {
        let exists = match input.kind {
            Kind::Website => website_exists(&mut tx, &cid, &target).await?,
            Kind::File => file_exists(&mut tx, &cid, &target).await?,
            Kind::Link => links(&mut tx, &cid, input.message_id.as_deref().unwrap())
                .await?
                .contains(&target),
        };
        if !exists {
            return Err(ApiError::new(404, "当前会话资料库中没有该条目。"));
        }
        sqlx::query("INSERT INTO library_pins(actor_id,conversation_id,kind,target,pinned_at,link_message_id)
            VALUES(?,?,?,?,?,?) ON CONFLICT(actor_id,conversation_id,kind,target) DO UPDATE
            SET link_message_id=excluded.link_message_id
            WHERE library_pins.link_message_id IS NOT excluded.link_message_id")
            .bind(&grant.user_id).bind(&cid).bind(kind).bind(&target).bind(iso(now())).bind(input.message_id)
            .execute(&mut *tx).await?.rows_affected()
    } else {
        sqlx::query("DELETE FROM library_pins WHERE actor_id=? AND conversation_id=? AND kind=? AND target=?")
            .bind(&grant.user_id).bind(&cid).bind(kind).bind(&target)
            .execute(&mut *tx).await?.rows_affected()
    };
    let output = pins(&mut tx, &cid, &grant.user_id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    if changed > 0 {
        store.emit("update", json!({}));
    }
    Ok(Json(output))
}
