use super::{Table, WorkspaceStore, access, creation, model, mutations, starter_skills, unread};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::sync::LazyLock;

static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../shared/bot-starter-templates.json"
    ))
    .expect("The checked-in Bot starter catalog is valid JSON")
});

pub(super) fn profile(id: &str, language: &str) -> Option<Value> {
    let template = CATALOG.get(id)?;
    let text = template["locales"].get(language)?;
    Some(json!({
        "name":text["name"],"role":text["role"],"description":text["description"],
        "instructions":text["instructions"],"avatar":template["avatar"],"color":template["color"],
    }))
}

fn invalid() -> ApiError {
    ApiError::bad("内置 Bot 模板无效。").with_code("INVALID_BOT_STARTER")
}

async fn result(
    store: &WorkspaceStore,
    conn: &mut SqliteConnection,
    user_id: &str,
    receipt: Value,
) -> Result<Value> {
    let view = creation::view(conn, receipt).await?;
    if view["status"] != "created" {
        return Err(ApiError::new(410, "这次安装的 Bot 或私聊已移除。")
            .with_code("CREATION_RESULT_MISSING"));
    }
    let mut agent = view["agents"][0].clone();
    let mut conversation = view["conversation"].clone();
    let agent_id = agent["id"].as_str().ok_or_else(invalid)?;
    let mut skills = Vec::new();
    for id in view["skillIds"].as_array().ok_or_else(invalid)? {
        if let Some(id) = id.as_str() {
            if let Some(skill) = WorkspaceStore::get_in(conn, Table::Skills, id).await? {
                if skill["agentId"] == agent_id {
                    skills.push(skill);
                }
            }
        }
    }
    agent["modelConfigured"] = json!(
        model::bot_configured_in(store, conn, agent_id)
            .await
            .unwrap_or(false)
    );
    unread::project(conn, user_id, std::slice::from_mut(&mut conversation)).await?;
    Ok(json!({"agent":agent,"conversation":conversation,"skills":skills}))
}

pub async fn post(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    only_fields(&body, &["id", "language", "requestId"])?;
    let starter = body["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 80)
        .ok_or_else(invalid)?;
    let language = body["language"]
        .as_str()
        .filter(|language| matches!(*language, "zh-CN" | "en"))
        .ok_or_else(invalid)?;
    let request_id = body["requestId"].as_str().ok_or_else(invalid)?;
    creation::valid_id(request_id)?;
    let digest = hex::encode(Sha256::digest(
        json!({"kind":"starter-bot","id":starter,"language":language}).to_string(),
    ));
    let actor = format!("user:{}", grant.user_id);
    let store = grant.store(&state).await?;
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.begin().await?;
    let (status, receipt) =
        if let Some((previous, receipt)) = creation::saved(&mut tx, &actor, request_id).await? {
            if previous != digest || receipt["starterId"] != starter {
                return Err(ApiError::new(409, "同一次请求不能用于不同内容。")
                    .with_code("CREATION_REQUEST_CONFLICT"));
            }
            (StatusCode::OK, receipt)
        } else {
            if creation::closed(&mut tx, &actor, request_id).await? {
                return Err(ApiError::new(409, "这次创建请求已结束，请发起新的创建。")
                    .with_code("CREATION_REQUEST_CLOSED"));
            }
            let profile = profile(starter, language).ok_or_else(invalid)?;
            let packs = starter_skills::bot(starter, language)?;
            let (agent, conversation) = mutations::create_bot(&store, &mut tx, &profile).await?;
            let skills = starter_skills::install(&mut tx, &packs, &agent["id"]).await?;
            let skill_ids: Vec<_> = skills.iter().map(|skill| skill["id"].clone()).collect();
            let receipt = json!({
                "requestId":request_id,"kind":"bot","agentIds":[agent["id"]],
                "starterId":starter,"language":language,
                "skillIds":skill_ids,"conversationId":conversation["id"],
                "createdAt":iso(now()),"userId":grant.user_id,"workspaceId":wid
            });
            creation::save(&mut tx, &actor, request_id, &digest, &receipt).await?;
            (StatusCode::CREATED, receipt)
        };
    let result = result(&store, &mut tx, &grant.user_id, receipt).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    if status == StatusCode::CREATED {
        store.emit("update", json!({}));
    }
    grant.authorize(&state).await?;
    Ok((status, Json(result)))
}
