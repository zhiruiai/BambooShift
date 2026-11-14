use super::{Table, WorkspaceStore, access, groups, mutations};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS creation_requests(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(actor_id,request_id))").execute(&mut *conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS creation_request_cancellations(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(actor_id,request_id))").execute(&mut *conn).await?;
    Ok(())
}
fn valid_id(id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(ApiError::bad("创建请求标识无效。"));
    }
    Ok(())
}
async fn saved(
    conn: &mut SqliteConnection,
    actor: &str,
    id: &str,
) -> Result<Option<(String, Value)>> {
    let row =
        sqlx::query("SELECT digest,data FROM creation_requests WHERE actor_id=? AND request_id=?")
            .bind(actor)
            .bind(id)
            .fetch_optional(conn)
            .await?;
    row.map(|row| {
        let data: Value = serde_json::from_str(row.get("data"))
            .map_err(|_| ApiError::new(409, "创建回执损坏，请核对已有结果。"))?;
        if data["requestId"] != id
            || format!("user:{}", data["userId"].as_str().unwrap_or("")) != actor
        {
            return Err(ApiError::new(409, "创建回执来源不匹配。"));
        }
        Ok((row.get("digest"), data))
    })
    .transpose()
}
async fn closed(conn: &mut SqliteConnection, actor: &str, id: &str) -> Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM creation_request_cancellations WHERE actor_id=? AND request_id=?",
    )
    .bind(actor)
    .bind(id)
    .fetch_optional(conn)
    .await?
    .is_some())
}
async fn view(conn: &mut SqliteConnection, mut receipt: Value) -> Result<Value> {
    let chat = WorkspaceStore::get_in(
        conn,
        Table::Conversations,
        receipt["conversationId"].as_str().unwrap_or(""),
    )
    .await?;
    receipt["status"] = json!("missing");
    receipt["agents"] = json!([]);
    receipt.as_object_mut().unwrap().remove("conversation");
    let Some(chat) = chat else { return Ok(receipt) };
    if (receipt["kind"] == "bot"
        && (chat["isGroup"] != false || chat["agentIds"] != receipt["agentIds"]))
        || (receipt["kind"] == "group" && chat["isGroup"] != true)
    {
        return Ok(receipt);
    }
    let Some(ids) = chat["agentIds"].as_array().filter(|ids| !ids.is_empty()) else {
        return Ok(receipt);
    };
    let mut seen = std::collections::HashSet::new();
    let mut agents = Vec::new();
    for id in ids {
        let Some(id) = id.as_str().filter(|id| !id.is_empty() && seen.insert(*id)) else {
            return Ok(receipt);
        };
        let Some(agent) = WorkspaceStore::get_in(conn, Table::Agents, id).await? else {
            return Ok(receipt);
        };
        agents.push(agent);
    }
    receipt["status"] = json!("created");
    receipt["conversation"] = chat;
    receipt["agents"] = json!(agents);
    Ok(receipt)
}
pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    valid_id(&id)?;
    let store = grant.store(&state).await?;
    let mut tx = store.pool.begin().await?;
    let actor = format!("user:{}", grant.user_id);
    let result = if let Some((_, receipt)) = saved(&mut tx, &actor, &id).await? {
        view(&mut tx, receipt).await?
    } else if closed(&mut tx, &actor, &id).await? {
        return Err(ApiError::new(410, "这次创建请求已结束。").with_code("CREATION_REQUEST_CLOSED"));
    } else {
        return Err(
            ApiError::new(404, "尚未找到这次创建请求。").with_code("CREATION_REQUEST_NOT_FOUND")
        );
    };
    tx.commit().await?;
    grant.authorize(&state).await?;
    Ok(Json(result))
}
pub async fn post(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let request_id = body["requestId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("创建请求标识无效。"))?;
    valid_id(request_id)?;
    let serialized = serde_json::to_vec(&body).map_err(|_| ApiError::bad("创建请求无效。"))?;
    if serialized.len() > 128 * 1024 {
        return Err(ApiError::new(413, "创建请求过大。"));
    }
    let digest = hex::encode(Sha256::digest(serialized));
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let actor = format!("user:{}", grant.user_id);
    if let Some((old, receipt)) = saved(&mut tx, &actor, request_id).await? {
        if old != digest {
            return Err(ApiError::new(409, "同一次请求不能用于不同内容。")
                .with_code("CREATION_REQUEST_CONFLICT"));
        }
        let result = view(&mut tx, receipt).await?;
        grant.authorize(&state).await?;
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(result)));
    }
    if closed(&mut tx, &actor, request_id).await? {
        return Err(ApiError::new(409, "这次创建请求已结束，请发起新的创建。")
            .with_code("CREATION_REQUEST_CLOSED"));
    }
    let (kind, chat, ids) = match body["kind"].as_str() {
        Some("bot") => {
            crate::error::only_fields(&body, &["kind", "requestId", "profile"])?;
            grant.authorize_owner(&state).await?;
            let (agent, chat) = mutations::create_bot(&store, &mut tx, &body["profile"]).await?;
            ("bot", chat, vec![agent["id"].clone()])
        }
        Some("group") => {
            crate::error::only_fields(&body, &["kind", "requestId", "title", "agentIds"])?;
            let chat = groups::create(
                &mut tx,
                &json!({"title":body["title"],"agentIds":body["agentIds"],"isGroup":true}),
            )
            .await?;
            let ids = chat["agentIds"].as_array().unwrap().clone();
            ("group", chat, ids)
        }
        _ => return Err(ApiError::bad("创建类型无效。")),
    };
    let receipt = json!({"requestId":request_id,"kind":kind,"agentIds":ids,"conversationId":chat["id"],"createdAt":iso(now()),"userId":grant.user_id,"workspaceId":wid});
    sqlx::query("INSERT INTO creation_requests(actor_id,request_id,digest,data) VALUES(?,?,?,?)")
        .bind(&actor)
        .bind(request_id)
        .bind(digest)
        .bind(receipt.to_string())
        .execute(&mut *tx)
        .await?;
    let result = view(&mut tx, receipt).await?;
    if kind == "bot" {
        grant.authorize_owner(&state).await?;
    }
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    grant.authorize(&state).await?;
    Ok((StatusCode::CREATED, Json(result)))
}
pub async fn cancel(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    crate::error::only_fields(&body, &[])?;
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    valid_id(&id)?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let actor = format!("user:{}", grant.user_id);
    let result = if let Some((_, receipt)) = saved(&mut tx, &actor, &id).await? {
        view(&mut tx, receipt).await?
    } else {
        sqlx::query(
            "INSERT OR IGNORE INTO creation_request_cancellations(actor_id,request_id) VALUES(?,?)",
        )
        .bind(&actor)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        json!({"requestId":id,"status":"not_submitted","userId":grant.user_id,"workspaceId":wid})
    };
    grant.authorize(&state).await?;
    tx.commit().await?;
    Ok(Json(result))
}
