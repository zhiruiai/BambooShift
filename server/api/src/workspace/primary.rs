use super::{Table, WorkspaceStore, access, mutations, time_zone};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS primary_bot(id TEXT PRIMARY KEY CHECK(id='primary'),data TEXT NOT NULL)").execute(conn).await?;
    Ok(())
}
async fn saved(conn: &mut SqliteConnection) -> Result<Value> {
    if let Some(row) = sqlx::query("SELECT data FROM primary_bot WHERE id='primary'")
        .fetch_optional(&mut *conn)
        .await?
    {
        let value: Value = serde_json::from_str(row.get("data"))
            .map_err(|_| ApiError::new(503, "主 Bot 设置暂不可用。"))?;
        if !value.is_object()
            || !value["checkIn"].is_object()
            || !value["revision"]
                .as_str()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            return Err(ApiError::new(503, "主 Bot 设置暂不可用。"));
        }
        return Ok(value);
    }
    let zone = time_zone::read(conn).await?["timeZone"].clone();
    Ok(
        json!({"available":true,"revision":"unset","agentId":null,"conversationId":null,"checkIn":{"enabled":true,"time":"09:00","timeZone":zone}}),
    )
}
fn direct(chat: &Value, id: &Value) -> bool {
    chat["isGroup"] == false && chat["agentIds"] == json!([id])
}
pub async fn read(conn: &mut SqliteConnection, kind: &str) -> Result<Value> {
    if kind != "personal" {
        return Ok(
            json!({"available":false,"reason":"team_workspace","revision":"unset","agentId":null,"conversationId":null,"checkIn":{"enabled":false,"time":"09:00"}}),
        );
    }
    let mut value = saved(conn).await?;
    if let Some(id) = value["agentId"].as_str() {
        let agent = WorkspaceStore::get_in(conn, Table::Agents, id).await?;
        if agent.as_ref().is_none_or(|a| a.get("sharedBot").is_some()) {
            value["agentId"] = Value::Null;
            value["conversationId"] = Value::Null;
            value["checkIn"]["enabled"] = json!(false);
        } else if let Some(chat) = WorkspaceStore::get_in(
            conn,
            Table::Conversations,
            value["conversationId"].as_str().unwrap_or(""),
        )
        .await?
        {
            if !direct(&chat, &value["agentId"]) {
                value["conversationId"] = Value::Null;
            }
        } else {
            value["conversationId"] = Value::Null;
        }
    }
    Ok(value)
}
async fn write(conn: &mut SqliteConnection, value: &Value) -> Result<()> {
    sqlx::query("INSERT INTO primary_bot(id,data) VALUES('primary',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(value.to_string()).execute(conn).await?;
    Ok(())
}
pub async fn deleted(conn: &mut SqliteConnection, agent_id: &str) -> Result<()> {
    let mut current = saved(conn).await?;
    if current["agentId"] == agent_id {
        current["agentId"] = Value::Null;
        current["conversationId"] = Value::Null;
        current["checkIn"]["enabled"] = json!(false);
        current["revision"] = json!(uuid::Uuid::new_v4().to_string());
        current["updatedAt"] = json!(iso(now()));
        write(conn, &current).await?;
    }
    Ok(())
}
fn schedule(body: &Value, current: &Value) -> Result<Value> {
    crate::error::only_fields(body, &["enabled", "time", "timeZone"])?;
    if !body["enabled"].is_boolean() {
        return Err(ApiError::bad("每日跟进开关无效。"));
    }
    time_zone::time(body["time"].as_str().unwrap_or(""))?;
    let zone = if let Some(zone) = body.get("timeZone") {
        time_zone::normalize(zone)?
    } else {
        time_zone::effective(current.get("timeZone"))?
    };
    Ok(json!({"enabled":body["enabled"],"time":body["time"],"timeZone":zone}))
}
pub async fn get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let value = read(&mut *store.pool.acquire().await?, &grant.kind).await?;
    grant.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn put(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    if grant.kind != "personal" {
        return Err(ApiError::new(403, "团队共享 Bot 不能设为个人主 Bot。"));
    }
    let mode = body["mode"]
        .as_str()
        .ok_or_else(|| ApiError::bad("主 Bot 操作无效。"))?;
    crate::error::only_fields(
        &body,
        match mode {
            "select" => &["mode", "expectedRevision", "agentId", "checkIn"],
            "create" => &["mode", "expectedRevision", "bot", "checkIn"],
            "clear" => &["mode", "expectedRevision"],
            _ => return Err(ApiError::bad("主 Bot 操作无效。")),
        },
    )?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let current = saved(&mut tx).await?;
    if current["revision"] != body["expectedRevision"] {
        return Err(ApiError::new(409, "主 Bot 设置已变化，请重新载入。"));
    }
    let mut next = current.clone();
    next["revision"] = json!(uuid::Uuid::new_v4().to_string());
    next["updatedAt"] = json!(iso(now()));
    if mode == "clear" {
        next["agentId"] = Value::Null;
        next["conversationId"] = Value::Null;
        next["checkIn"]["enabled"] = json!(false);
    } else {
        next["checkIn"] = schedule(&body["checkIn"], &current["checkIn"])?;
        let agent = if mode == "create" {
            mutations::create_bot(&mut tx, &body["bot"]).await?.0
        } else {
            mutations::find(
                &mut tx,
                Table::Agents,
                body["agentId"].as_str().unwrap_or(""),
            )
            .await?
        };
        mutations::local(&agent)?;
        let chats = WorkspaceStore::list_in(&mut tx, Table::Conversations).await?;
        let chosen = chats
            .iter()
            .find(|c| c["id"] == current["conversationId"] && direct(c, &agent["id"]))
            .or_else(|| chats.iter().find(|c| direct(c, &agent["id"])));
        let chat = if let Some(chat) = chosen {
            chat.clone()
        } else {
            let chat = json!({"id":uuid::Uuid::new_v4().to_string(),"title":agent["name"],"agentIds":[agent["id"]],"isGroup":false,"updatedAt":iso(now()),"unread":0,"pinned":false});
            WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
            chat
        };
        next["agentId"] = agent["id"].clone();
        next["conversationId"] = chat["id"].clone();
    }
    write(&mut tx, &next).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    grant.authorize(&state).await?;
    Ok(Json(next))
}
