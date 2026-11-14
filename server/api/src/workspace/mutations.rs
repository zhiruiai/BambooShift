use super::{Table, WorkspaceStore, access, profiles};
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
use sqlx::SqliteConnection;

pub async fn assert_idle(state: &State, conn: &mut SqliteConnection, wid: &str) -> Result<()> {
    for conversation in WorkspaceStore::list_in(conn, Table::Conversations).await? {
        if let Some(id) = conversation["id"].as_str() {
            if state.agent_runs.get(&format!("{wid}:{id}")).await.is_some() {
                return Err(ApiError::new(409, "请先停止正在执行的任务。"));
            }
        }
    }
    if WorkspaceStore::list_in(conn, Table::Messages)
        .await?
        .iter()
        .any(|m| m["status"] == "running")
    {
        return Err(ApiError::new(409, "请先停止正在执行的任务。"));
    }
    Ok(())
}
pub async fn find(conn: &mut SqliteConnection, table: Table, id: &str) -> Result<Value> {
    WorkspaceStore::get_in(conn, table, id)
        .await?
        .ok_or_else(|| ApiError::new(404, "项目不存在。"))
}
pub fn local(agent: &Value) -> Result<()> {
    if agent.get("sharedBot").is_some() {
        return Err(ApiError::new(403, "共享 Bot 的定义由来源拥有者维护。"));
    }
    Ok(())
}
pub async fn create_bot(
    store: &WorkspaceStore,
    conn: &mut SqliteConnection,
    body: &Value,
) -> Result<(Value, Value)> {
    let mut agent = profiles::validate(body, false)?;
    super::model::validate_bot_selection(store, conn, &agent["modelProfileId"]).await?;
    super::avatars::publish(conn, &agent["avatarImageId"]).await?;
    agent["id"] = json!(uuid::Uuid::new_v4().to_string());
    agent["configRevision"] = json!(uuid::Uuid::new_v4().to_string());
    agent["status"] = json!("idle");
    let conversation = json!({"id":uuid::Uuid::new_v4().to_string(),"title":agent["name"],"agentIds":[agent["id"]],"isGroup":false,"updatedAt":iso(now()),"unread":0,"pinned":false});
    WorkspaceStore::put_in(conn, Table::Agents, &agent).await?;
    WorkspaceStore::put_in(conn, Table::Conversations, &conversation).await?;
    Ok((agent, conversation))
}
pub async fn add_agent(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let (agent, _) = create_bot(&store, &mut tx, &body).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok((StatusCode::CREATED, Json(agent)))
}
pub async fn edit_agent(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(mut body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let expected = body
        .as_object_mut()
        .ok_or_else(|| ApiError::bad("Bot设置无效。"))?
        .remove("expectedRevision");
    let changes = profiles::validate(&body, true)?;
    let mut tx = store.begin().await?;
    let mut agent = find(&mut tx, Table::Agents, &id).await?;
    local(&agent)?;
    super::model::validate_bot_selection(&store, &mut tx, &changes["modelProfileId"]).await?;
    if expected
        .as_ref()
        .is_some_and(|value| value != &agent["configRevision"])
    {
        return Err(ApiError::new(409, "Bot设置已更新，请载入最新配置。"));
    }
    super::avatars::publish(&mut tx, &changes["avatarImageId"]).await?;
    let changed = changes
        .as_object()
        .unwrap()
        .iter()
        .any(|(key, value)| agent[key] != *value);
    for (key, value) in changes.as_object().unwrap() {
        agent[key] = value.clone();
    }
    if changed {
        agent["configRevision"] = json!(uuid::Uuid::new_v4().to_string());
    }
    WorkspaceStore::put_in(&mut tx, Table::Agents, &agent).await?;
    for mut chat in WorkspaceStore::list_in(&mut tx, Table::Conversations).await? {
        if chat["isGroup"] == false && chat["agentIds"][0] == id {
            chat["title"] = agent["name"].clone();
            WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
        }
    }
    grant.authorize(&state).await?;
    tx.commit().await?;
    state.workspace.emit_all("update", json!({})).await;
    Ok(Json(agent))
}
pub async fn remove_agent(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let computer = state.computer.get(&state, store.clone()).await?;
    let _computer_deletion = computer.deletion_guard(&id).await?;
    let mut tx = store.begin().await?;
    assert_idle(&state, &mut tx, &wid).await?;
    let agent = find(&mut tx, Table::Agents, &id).await?;
    local(&agent)?;
    if WorkspaceStore::list_in(&mut tx, Table::Agents).await?.len() < 2 {
        return Err(ApiError::new(409, "请至少保留一位 Bot。"));
    }
    let conversations = WorkspaceStore::list_in(&mut tx, Table::Conversations).await?;
    for chat in &conversations {
        if chat["isGroup"] == true && chat["agentIds"] == json!([id]) {
            return Err(ApiError::new(409, "请先为工作组保留另一位成员。"));
        }
    }
    for mut chat in conversations {
        let old = chat["agentIds"].as_array().cloned().unwrap_or_default();
        if old.contains(&json!(id)) {
            let rest: Vec<Value> = old.into_iter().filter(|value| value != &id).collect();
            if rest.is_empty() {
                remove_chat(&mut tx, chat["id"].as_str().unwrap_or("")).await?;
            } else {
                chat["agentIds"] = json!(rest);
                super::groups::reconcile(&mut chat);
                WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
            }
        }
    }
    let author = json!({"id":id,"name":agent["name"],"role":agent["role"],"avatar":agent["avatar"],"color":agent["color"],"avatarImageId":agent["avatarImageId"],"removed":true});
    for mut message in WorkspaceStore::list_in(&mut tx, Table::Messages).await? {
        if message["agentId"] == id && message["role"] != "user" {
            if !message["metadata"].is_object() {
                message["metadata"] = json!({});
            }
            message["metadata"]["author"] = author.clone();
            WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        }
    }
    for table in [Table::Memories, Table::Skills, Table::Routines] {
        for value in WorkspaceStore::list_in(&mut tx, table).await? {
            if value["agentId"] == id {
                WorkspaceStore::delete_in(&mut tx, table, value["id"].as_str().unwrap_or(""))
                    .await?;
            }
        }
    }
    super::primary::deleted(&mut tx, &id).await?;
    WorkspaceStore::delete_in(&mut tx, Table::Agents, &id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    state.workspace.emit_all("update", json!({})).await;
    Ok(Json(json!({"ok":true})))
}
pub async fn remove_chat(conn: &mut SqliteConnection, id: &str) -> Result<()> {
    WorkspaceStore::delete_in(conn, Table::Conversations, id).await?;
    for table in [Table::Messages, Table::Routines] {
        for value in WorkspaceStore::list_in(conn, table).await? {
            if value["conversationId"] == id {
                WorkspaceStore::delete_in(conn, table, value["id"].as_str().unwrap_or("")).await?;
            }
        }
    }
    Ok(())
}
pub async fn delete_chat(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    assert_idle(&state, &mut tx, &wid).await?;
    let chat = find(&mut tx, Table::Conversations, &id).await?;
    super::groups::assert_not_managed(&mut tx, &chat).await?;
    remove_chat(&mut tx, &id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(Json(json!({"ok":true})))
}
