use super::store;
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};

pub(super) async fn repair(state: &State, grant: &WorkspaceAccess, id: &str) -> Result<Value> {
    // Canonical state is already committed. A failed projection stays explicitly pending.
    let result = project(state, grant, id).await;
    grant.authorize_owner(state).await?;
    if let Ok(value) = result {
        return Ok(value);
    }
    Ok(store::view(
        &store::read(
            &mut *state.bot_templates.pool.acquire().await?,
            &grant.workspace_id,
            id,
        )
        .await?
        .row,
    ))
}
async fn project(state: &State, grant: &WorkspaceAccess, id: &str) -> Result<Value> {
    grant.authorize_owner(state).await?;
    let mut central = state.bot_templates.pool.begin().await?;
    let value = store::read(&mut central, &grant.workspace_id, id).await?;
    let row = &value.row;
    let mut name = row["sourceName"].clone();
    if let Some(publication) = row.get("publication") {
        let raw: Option<String> =
            sqlx::query_scalar("SELECT data FROM template_versions WHERE id=? AND template_id=?")
                .bind(publication["versionId"].as_str())
                .bind(id)
                .fetch_optional(&mut *central)
                .await?;
        if let Some(raw) = raw {
            let v: Value =
                serde_json::from_str(&raw).map_err(|_| ApiError::new(409, "模板版本数据无效。"))?;
            name = v["blueprint"]["profile"]["name"].clone();
        }
    }
    central.commit().await?;
    let mut card = json!({"templateId":id,"sequence":row["sequence"],"name":name,"status":if row.get("publication").is_some(){"published"}else if row["revoked"]==true{"revoked"}else{"draft"}});
    if let Some(publication) = row.get("publication") {
        card["audience"] = publication["audience"].clone();
        card["path"] = json!(format!(
            "/templates/{}",
            publication["token"].as_str().unwrap_or("")
        ));
    }
    let target = grant.store(state).await?;
    let mut tx = target.begin().await?;
    let cid = row["sourceConversationId"]
        .as_str()
        .ok_or_else(|| ApiError::new(409, "来源单聊不可用。"))?;
    let mut chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, cid)
        .await?
        .ok_or_else(|| ApiError::new(409, "来源单聊不可用。"))?;
    if chat["isGroup"] != false || chat["agentIds"] != json!([row["sourceAgentId"]]) {
        return Err(ApiError::new(409, "来源单聊已变化。"));
    }
    let mid = row["messageId"]
        .as_str()
        .ok_or_else(|| ApiError::new(409, "模板卡标识无效。"))?;
    let previous = WorkspaceStore::get_in(&mut tx, Table::Messages, mid).await?;
    let mut changed = None;
    if let Some(previous) = &previous {
        if previous["conversationId"] != cid
            || previous["metadata"]["botTemplate"]["templateId"] != id
        {
            return Err(ApiError::new(409, "模板卡位置已不可用。"));
        }
    }
    if previous.as_ref().is_none_or(|m| {
        m["metadata"]["botTemplate"]["sequence"]
            .as_u64()
            .unwrap_or(0)
            < row["sequence"].as_u64().unwrap()
    }) {
        let mut message = previous.clone().unwrap_or_else(|| json!({}));
        for (key,value) in json!({"id":mid,"conversationId":cid,"agentId":row["sourceAgentId"],"role":"assistant","kind":"text","status":"done","createdAt":row["createdAt"],"content":format!("Bot 模板：{}",name.as_str().unwrap_or(""))}).as_object().unwrap(){message[key]=value.clone();}
        if !message["metadata"].is_object() {
            message["metadata"] = json!({});
        }
        message["metadata"]["botTemplate"] = card;
        WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        if previous.is_none() {
            if chat["updatedAt"].as_str() < row["createdAt"].as_str() {
                chat["updatedAt"] = row["createdAt"].clone();
            }
            WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
        }
        changed = Some(message);
    }
    grant.authorize_owner(state).await?;
    tx.commit().await?;
    if let Some(message) = changed {
        target.emit("message", message);
        target.emit("update", json!({}));
    }
    let mut tx = state
        .bot_templates
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await?;
    let mut latest = store::read(&mut tx, &grant.workspace_id, id).await?;
    if latest.row["sequence"] == row["sequence"] {
        latest.row["projectionPending"] = json!(false);
        store::save(&mut tx, &latest).await?;
    }
    grant.authorize_owner(state).await?;
    tx.commit().await?;
    Ok(store::view(&latest.row))
}
