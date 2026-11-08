use super::{Table, WorkspaceStore, access};
use crate::{
    db::State,
    error::{ApiError, Body, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sidebar_rosters(actor_id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    )
    .execute(conn)
    .await?;
    Ok(())
}
fn key(target: &Value) -> Result<String> {
    crate::error::only_fields(target, &["kind", "id"])?;
    let kind = target["kind"]
        .as_str()
        .filter(|k| ["bot", "conversation"].contains(k))
        .ok_or_else(|| ApiError::bad("列表目标无效。"))?;
    let id = target["id"]
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or_else(|| ApiError::bad("列表目标无效。"))?;
    Ok(format!("{kind}:{id}"))
}
async fn exists(conn: &mut SqliteConnection, target: &Value) -> Result<bool> {
    key(target)?;
    let id = target["id"].as_str().unwrap();
    if target["kind"] == "bot" {
        return Ok(WorkspaceStore::get_in(conn, Table::Agents, id)
            .await?
            .is_some());
    }
    Ok(WorkspaceStore::get_in(conn, Table::Conversations, id)
        .await?
        .is_some_and(|c| c["isGroup"] == true || c["agentIds"].as_array().map_or(0, Vec::len) != 1))
}
pub async fn read(conn: &mut SqliteConnection, user: &str) -> Result<Value> {
    let actor = format!("user:{user}");
    if let Some(row) = sqlx::query("SELECT data FROM sidebar_rosters WHERE actor_id=?")
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await?
    {
        let mut value: Value = serde_json::from_str(row.get("data"))
            .map_err(|_| ApiError::new(409, "个人列表数据不可用。"))?;
        if !value["revision"].is_string()
            || !value["sections"].is_array()
            || !value["entries"].is_array()
        {
            return Err(ApiError::new(409, "个人列表数据不可用。"));
        }
        let mut entries = Vec::new();
        for entry in value["entries"].as_array().unwrap() {
            if exists(conn, &entry["target"]).await? {
                entries.push(entry.clone());
            }
        }
        value["entries"] = json!(entries);
        return Ok(value);
    }
    let mut entries = BTreeMap::new();
    for c in WorkspaceStore::list_in(conn, Table::Conversations).await? {
        if c["pinned"] != true {
            continue;
        }
        let target = if c["isGroup"] != true && c["agentIds"].as_array().map_or(0, Vec::len) == 1 {
            json!({"kind":"bot","id":c["agentIds"][0]})
        } else {
            json!({"kind":"conversation","id":c["id"]})
        };
        if exists(conn, &target).await? {
            entries.insert(
                key(&target)?,
                json!({"target":target,"pinned":true,"hidden":false,"sectionId":null}),
            );
        }
    }
    Ok(
        json!({"revision":"unset","sections":[],"entries":entries.into_values().collect::<Vec<_>>()}),
    )
}
fn name(value: &Value) -> Result<String> {
    let name = crate::error::text(value, "分区名称", 80)?;
    if name
        .chars()
        .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
    {
        return Err(ApiError::bad("分区名称无效。"));
    }
    Ok(name)
}
fn section(sections: &[Value], id: &Value) -> Result<usize> {
    sections
        .iter()
        .position(|s| s["id"] == *id && id.is_string())
        .ok_or_else(|| {
            ApiError::new(409, "这个分区已不存在，请刷新后重试。")
                .with_code("SIDEBAR_SECTION_MISSING")
        })
}
fn unique(sections: &[Value], name: &str, except: Option<usize>) -> Result<()> {
    if sections.iter().enumerate().any(|(i, s)| {
        Some(i) != except && s["name"].as_str().unwrap_or("").to_lowercase() == name.to_lowercase()
    }) {
        return Err(
            ApiError::new(409, "已有同名分区，请换一个名称。").with_code("SIDEBAR_SECTION_EXISTS")
        );
    }
    Ok(())
}
async fn target(conn: &mut SqliteConnection, value: &Value) -> Result<Value> {
    if !exists(conn, value).await? {
        return Err(
            ApiError::new(409, "这位 Bot 或群聊已不存在。").with_code("SIDEBAR_TARGET_MISSING")
        );
    }
    Ok(value.clone())
}
fn place(entries: &mut BTreeMap<String, Value>, target: &Value, changes: &Value) -> Result<()> {
    let key = key(target)?;
    let entry = entries
        .entry(key)
        .or_insert_with(|| json!({"target":target,"pinned":false,"hidden":false,"sectionId":null}));
    for (k, v) in changes.as_object().unwrap() {
        entry[k] = v.clone();
    }
    Ok(())
}
async fn apply(conn: &mut SqliteConnection, user: &str, body: &Value) -> Result<Value> {
    crate::error::only_fields(body, &["expectedRevision", "operation"])?;
    let current = read(conn, user).await?;
    if !body["expectedRevision"].is_string() || body["expectedRevision"] != current["revision"] {
        return Err(
            ApiError::new(409, "列表已在另一处更新，请载入最新列表后重试。")
                .with_code("SIDEBAR_ROSTER_CONFLICT"),
        );
    }
    let mut sections = current["sections"].as_array().unwrap().clone();
    let mut entries = BTreeMap::new();
    for entry in current["entries"].as_array().unwrap() {
        entries.insert(key(&entry["target"])?, entry.clone());
    }
    let op = &body["operation"];
    match op["type"].as_str() {
        Some("set-entry") => {
            crate::error::only_fields(op, &["type", "target", "pinned", "hidden", "sectionId"])?;
            let mapped = target(conn, &op["target"]).await?;
            let mut changes = json!({});
            for field in ["pinned", "hidden"] {
                if let Some(v) = op.get(field) {
                    if !v.is_boolean() {
                        return Err(ApiError::bad("列表选项无效。"));
                    }
                    changes[field] = v.clone();
                }
            }
            if let Some(id) = op.get("sectionId") {
                if !id.is_null() {
                    section(&sections, id)?;
                }
                changes["sectionId"] = id.clone();
            }
            if changes.as_object().unwrap().is_empty() {
                return Err(ApiError::bad("请提供要更改的列表设置。"));
            }
            place(&mut entries, &mapped, &changes)?;
        }
        Some("create-section") => {
            crate::error::only_fields(op, &["type", "name", "target"])?;
            let title = name(&op["name"])?;
            unique(&sections, &title, None)?;
            if sections.len() >= 100 {
                return Err(ApiError::new(409, "最多保留100个分区。"));
            }
            let id = uuid::Uuid::new_v4().to_string();
            sections.push(json!({"id":id,"name":title,"collapsed":false}));
            if let Some(t) = op.get("target") {
                let mapped = target(conn, t).await?;
                place(&mut entries, &mapped, &json!({"sectionId":id}))?;
            }
        }
        Some("rename-section") => {
            crate::error::only_fields(op, &["type", "id", "name"])?;
            let index = section(&sections, &op["id"])?;
            let title = name(&op["name"])?;
            unique(&sections, &title, Some(index))?;
            sections[index]["name"] = json!(title);
        }
        Some("set-section-collapsed") => {
            crate::error::only_fields(op, &["type", "id", "collapsed"])?;
            let index = section(&sections, &op["id"])?;
            if !op["collapsed"].is_boolean() {
                return Err(ApiError::bad("分区收起设置无效。"));
            }
            sections[index]["collapsed"] = op["collapsed"].clone();
        }
        Some("delete-section") => {
            crate::error::only_fields(op, &["type", "id"])?;
            let index = section(&sections, &op["id"])?;
            sections.remove(index);
            for e in entries.values_mut() {
                if e["sectionId"] == op["id"] {
                    e["sectionId"] = Value::Null;
                }
            }
        }
        _ => return Err(ApiError::bad("不支持的列表整理操作。")),
    }
    entries.retain(|_, e| e["pinned"] == true || e["hidden"] == true || !e["sectionId"].is_null());
    if entries.len() > 5000 {
        return Err(ApiError::new(409, "个人列表整理记录已达上限。"));
    }
    let next = json!({"revision":uuid::Uuid::new_v4().to_string(),"sections":sections,"entries":entries.into_values().collect::<Vec<_>>()});
    sqlx::query("INSERT INTO sidebar_rosters(actor_id,data) VALUES(?,?) ON CONFLICT(actor_id) DO UPDATE SET data=excluded.data").bind(format!("user:{user}")).bind(next.to_string()).execute(conn).await?;
    Ok(next)
}
pub async fn get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.pool.begin().await?;
    let value = read(&mut tx, &grant.user_id).await?;
    tx.commit().await?;
    grant.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn put(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let value = apply(&mut tx, &grant.user_id, &body).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    grant.authorize(&state).await?;
    Ok(Json(value))
}
