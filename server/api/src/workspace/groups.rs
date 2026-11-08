use super::{Table, WorkspaceStore, access, mutations};
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
use sqlx::SqliteConnection;

pub async fn members(
    conn: &mut SqliteConnection,
    value: &Value,
    old: Option<&Value>,
) -> Result<Vec<Value>> {
    let ids = value
        .as_array()
        .filter(|ids| !ids.is_empty() && ids.len() <= 500)
        .ok_or_else(|| ApiError::bad("请至少选择一位 Bot。"))?;
    let old_ids = old.and_then(Value::as_array);
    let large = old_ids.is_some_and(|old| old.len() > 6);
    if (!large && ids.len() > 6) || (large && ids.iter().any(|id| !old_ids.unwrap().contains(id))) {
        return Err(ApiError::bad(
            "工作组最多六位 Bot；已有超额工作组只能保留或减少成员。",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let id = id.as_str().ok_or_else(|| ApiError::bad("Bot标识无效。"))?;
        if !seen.insert(id) {
            return Err(ApiError::bad("不能重复选择同一位Bot。"));
        }
        mutations::find(conn, Table::Agents, id).await?;
    }
    Ok(ids.clone())
}
pub async fn create(conn: &mut SqliteConnection, body: &Value) -> Result<Value> {
    crate::error::only_fields(body, &["title", "agentIds", "isGroup"])?;
    let ids = members(conn, &body["agentIds"], None).await?;
    let group = body
        .get("isGroup")
        .map(|v| v.as_bool().ok_or_else(|| ApiError::bad("会话类型无效。")))
        .transpose()?
        .unwrap_or(ids.len() > 1);
    if (group && ids.len() < 2) || (!group && ids.len() != 1) {
        return Err(ApiError::bad("新工作组需要2–6位Bot，私聊只能有一位。"));
    }
    let title = body.get("title").cloned().unwrap_or(json!(if group {
        "新的工作组"
    } else {
        "新的会话"
    }));
    let value = json!({"id":uuid::Uuid::new_v4().to_string(),"title":crate::error::text(&title,"名称",100)?,"agentIds":ids,"isGroup":group,"updatedAt":iso(now()),"unread":0,"pinned":false});
    WorkspaceStore::put_in(conn, Table::Conversations, &value).await?;
    Ok(value)
}
pub fn reconcile(chat: &mut Value) {
    if !chat["teamBrief"].is_object() {
        return;
    }
    let ids = chat["agentIds"].as_array().cloned().unwrap_or_default();
    chat["teamBrief"]["leadAgentId"] = ids.first().cloned().unwrap_or(Value::Null);
    let old = chat["teamBrief"]["assignments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let assignments:Vec<Value>=ids.iter().map(|id|json!({"agentId":id,"assignment":old.iter().find(|a|a["agentId"]==*id).map(|a|a["assignment"].clone()).unwrap_or(json!("分工待补充"))})).collect();
    chat["teamBrief"]["assignments"] = json!(assignments);
}
pub async fn assert_not_managed(conn: &mut SqliteConnection, chat: &Value) -> Result<()> {
    if crate::shared_bots::is_main_conversation(conn, chat["id"].as_str().unwrap_or("")).await? {
        return Err(ApiError::new(403, "共享Bot的主私聊不能改写或删除。"));
    }
    for agent in WorkspaceStore::list_in(conn, Table::Agents).await? {
        if agent.get("sharedBot").is_some() && agent["sharedBot"]["conversationId"] == chat["id"] {
            return Err(ApiError::new(403, "共享Bot的主私聊不能改写或删除。"));
        }
    }
    Ok(())
}
fn snapshot(chat: &Value) -> Value {
    let data = json!({"title":chat["title"],"agentIds":chat["agentIds"],"isGroup":chat["isGroup"],"teamBrief":chat["teamBrief"]});
    json!({"conversation":chat,"revision":hex::encode(Sha256::digest(serde_json::to_vec(&data).unwrap_or_default()))})
}
pub async fn post(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let access = access::require(&state, &headers, &wid, false, true).await?;
    let store = access.store(&state).await?;
    let mut tx = store.begin().await?;
    let value = create(&mut tx, &body).await?;
    access.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok((StatusCode::CREATED, Json(value)))
}
pub async fn patch(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    crate::error::only_fields(&body, &["title", "agentIds", "read", "readThrough"])?;
    let access = access::require(&state, &headers, &wid, false, true).await?;
    let store = access.store(&state).await?;
    let mut tx = store.begin().await?;
    let mut chat = mutations::find(&mut tx, Table::Conversations, &id).await?;
    if body.get("title").is_some() || body.get("agentIds").is_some() {
        assert_not_managed(&mut tx, &chat).await?;
    }
    if let Some(title) = body.get("title") {
        chat["title"] = json!(crate::error::text(title, "名称", 100)?);
    }
    if body.get("read").is_some_and(|v| !v.is_boolean()) {
        return Err(ApiError::bad("已读选项无效。"));
    }
    if body.get("readThrough").is_some() && body["read"] != true {
        return Err(ApiError::bad("请确认已读操作。"));
    }
    let read_changed = if body["read"] == true {
        super::unread::acknowledge(&mut tx, &access.user_id, &id, body.get("readThrough")).await?
    } else {
        false
    };
    if let Some(ids) = body.get("agentIds") {
        let ids = members(
            &mut tx,
            ids,
            if chat["isGroup"] == true {
                Some(&chat["agentIds"])
            } else {
                None
            },
        )
        .await?;
        chat["isGroup"] = json!(chat["isGroup"] == true || ids.len() > 1);
        chat["agentIds"] = json!(ids);
        reconcile(&mut chat);
    }
    let modified = body.get("title").is_some() || body.get("agentIds").is_some();
    if modified {
        WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
    }
    super::unread::project(&mut tx, &access.user_id, std::slice::from_mut(&mut chat)).await?;
    access.authorize(&state).await?;
    tx.commit().await?;
    if modified || read_changed {
        store.emit("update", json!({}));
    }
    Ok(Json(chat))
}
pub async fn settings(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let access = access::require(&state, &headers, &wid, false, true).await?;
    let store = access.store(&state).await?;
    let mut conn = store.pool.acquire().await?;
    let mut chat = mutations::find(&mut conn, Table::Conversations, &id).await?;
    if chat["isGroup"] != true {
        return Err(ApiError::bad("这不是工作组。"));
    }
    super::unread::project(&mut conn, &access.user_id, std::slice::from_mut(&mut chat)).await?;
    access.authorize(&state).await?;
    Ok(Json(snapshot(&chat)))
}
pub async fn edit_settings(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    crate::error::only_fields(
        &body,
        &["expectedRevision", "title", "agentIds", "teamBrief"],
    )?;
    let access = access::require(&state, &headers, &wid, false, true).await?;
    let store = access.store(&state).await?;
    let mut tx = store.begin().await?;
    let mut chat = mutations::find(&mut tx, Table::Conversations, &id).await?;
    if chat["isGroup"] != true {
        return Err(ApiError::bad("这不是工作组。"));
    }
    assert_not_managed(&mut tx, &chat).await?;
    if body["expectedRevision"] != snapshot(&chat)["revision"] {
        return Err(ApiError::new(409, "工作组设置已变化，请重新载入。"));
    }
    let ids = members(&mut tx, &body["agentIds"], Some(&chat["agentIds"])).await?;
    let title = crate::error::text(&body["title"], "名称", 100)?;
    if title
        .chars()
        .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
    {
        return Err(ApiError::bad("工作组名称不能换行。"));
    }
    chat["title"] = json!(title);
    chat["agentIds"] = json!(ids);
    if chat["teamBrief"].is_object() && body.get("teamBrief").is_none() {
        return Err(ApiError::bad(
            "请完整提交工作目标、负责人和每位成员的分工。",
        ));
    }
    if let Some(brief) = body.get("teamBrief") {
        crate::error::only_fields(brief, &["goal", "summary", "leadAgentId", "assignments"])?;
        if brief["leadAgentId"] != chat["agentIds"][0] {
            return Err(ApiError::bad("工作组负责人必须是名单首位Bot。"));
        }
        for (field, max) in [("goal", 6000), ("summary", 2000)] {
            let s = brief[field]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max)
                .ok_or_else(|| ApiError::bad("工作组任务说明无效。"))?;
            if s.contains('\0') {
                return Err(ApiError::bad("任务说明包含无效字符。"));
            }
        }
        let assignments = brief["assignments"]
            .as_array()
            .ok_or_else(|| ApiError::bad("分工无效。"))?;
        if assignments.len() != ids.len() {
            return Err(ApiError::bad("请为每位成员填写一份完整分工。"));
        }
        let mut seen = std::collections::HashSet::new();
        for item in assignments {
            crate::error::only_fields(item, &["agentId", "assignment"])?;
            if !ids.contains(&item["agentId"])
                || !seen.insert(item["agentId"].as_str().unwrap_or(""))
            {
                return Err(ApiError::bad("分工包含无效成员。"));
            }
            let _ = crate::error::text(&item["assignment"], "分工", 2000)?;
        }
        chat["teamBrief"] = brief.clone();
    }
    reconcile(&mut chat);
    chat["updatedAt"] = json!(iso(now()));
    WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
    super::unread::project(&mut tx, &access.user_id, std::slice::from_mut(&mut chat)).await?;
    access.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    access.authorize(&state).await?;
    Ok(Json(snapshot(&chat)))
}
