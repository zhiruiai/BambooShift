use super::{routines, transfer_store as data};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields, text},
    workspace::{Table, WorkspaceAccess, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};

async fn live(state: &State, actor: &WorkspaceAccess) -> Result<()> {
    if state.is_closing() {
        return Err(ApiError::new(503, "服务正在停止。"));
    }
    actor.authorize_owner(state).await
}
fn personal(actor: &WorkspaceAccess) -> Result<()> {
    if actor.kind != "personal" {
        return Err(ApiError::new(
            403,
            "目前仅支持在个人空间的本地 Bot 单聊之间转交。",
        ));
    }
    Ok(())
}
pub async fn transfer(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    only_fields(
        &body,
        &[
            "requestId",
            "expectedRoutine",
            "targetAgentId",
            "targetConversationId",
        ],
    )?;
    let request = data::identifier(&body["requestId"])?;
    let digest = data::hash(&json!({"routineId":id,"body":body}));
    let store = actor.store(&state).await?;
    {
        let mut conn = store.pool.acquire().await?;
        if let Some(prior) = data::replay(&mut conn, &actor, &request, &id, &digest).await? {
            live(&state, &actor).await?;
            return Ok(Json(prior));
        }
    }
    personal(&actor)?;
    live(&state, &actor).await?;
    let _maintenance = state.agent_runs.try_maintenance(&wid).await?;
    let mut tx = store.begin().await?;
    if let Some(prior) = data::replay(&mut tx, &actor, &request, &id, &digest).await? {
        live(&state, &actor).await?;
        return Ok(Json(prior));
    }
    if data::is_closed(&mut tx, &actor, &request).await? {
        return Err(data::closed());
    }
    let mut routine = WorkspaceStore::get_in(&mut tx, Table::Routines, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "例行任务不存在。"))?;
    if body["expectedRoutine"] != routines::config(&routine) {
        return Err(data::conflict());
    }
    let source_agent = routine["agentId"]
        .as_str()
        .ok_or_else(data::conflict)?
        .to_owned();
    let source_chat = routine["conversationId"]
        .as_str()
        .ok_or_else(data::conflict)?
        .to_owned();
    let target_agent = text(&body["targetAgentId"], "目标 Bot", 160)?;
    let target_chat = text(&body["targetConversationId"], "目标单聊", 160)?;
    if target_agent == source_agent {
        return Err(ApiError::bad("请选择另一位 Bot。"));
    }
    data::direct_target(&mut tx, &source_agent, &source_chat).await?;
    data::direct_target(&mut tx, &target_agent, &target_chat).await?;
    // Persisted inputs also cover interrupted admission and restart recovery windows.
    if WorkspaceStore::list_in(&mut tx, Table::Messages)
        .await?
        .iter()
        .any(|m| m["delivery"]["state"] == "queued" || m["status"] == "running")
    {
        return Err(ApiError::new(
            409,
            "当前空间还有任务或排队消息，请结束后再转交。",
        ));
    }
    if sqlx::query_scalar::<_,i64>("SELECT count(*) FROM routine_runs WHERE routine_id=? AND json_extract(data,'$.status')='running'").bind(&id).fetch_one(&mut *tx).await?>0 {
        return Err(ApiError::new(409,"此例行任务仍在运行，请等本次完成后再转交。"));
    }
    routine["agentId"] = json!(target_agent);
    routine["conversationId"] = json!(target_chat);
    super::public_research::clear(&mut routine);
    let receipt = json!({"requestId":request,"routineId":id,"userId":actor.user_id,"workspaceId":wid,"sourceAgentId":source_agent,"sourceConversationId":source_chat,"targetAgentId":target_agent,"targetConversationId":target_chat,"appliedRevision":data::hash(&routines::config(&routine)),"createdAt":iso(now())});
    WorkspaceStore::put_in(&mut tx, Table::Routines, &routine).await?;
    sqlx::query("INSERT INTO routine_transfers VALUES(?,?,?,?,?)")
        .bind(&actor.user_id)
        .bind(&request)
        .bind(&id)
        .bind(digest)
        .bind(receipt.to_string())
        .execute(&mut *tx)
        .await?;
    live(&state, &actor).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    let response = data::view(&mut *store.pool.acquire().await?, receipt).await?;
    live(&state, &actor).await?;
    Ok(Json(response))
}
pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    data::identifier(&json!(id))?;
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let mut conn = store.pool.acquire().await?;
    let saved = if let Some(saved) = data::receipt(&mut conn, &actor, &id).await? {
        data::view(&mut conn, saved).await?
    } else if data::is_closed(&mut conn, &actor, &id).await? {
        return Err(data::closed());
    } else {
        return Err(ApiError::new(404, "尚未找到此转交回执。"));
    };
    actor.authorize_owner(&state).await?;
    Ok(Json(saved))
}
pub async fn cancel(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &[])?;
    data::identifier(&json!(id))?;
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    live(&state, &actor).await?;
    let store = actor.store(&state).await?;
    let mut tx = store.begin().await?;
    let response = if let Some(saved) = data::receipt(&mut tx, &actor, &id).await? {
        data::view(&mut tx, saved).await?
    } else {
        sqlx::query("INSERT OR IGNORE INTO routine_transfer_closures VALUES(?,?)")
            .bind(&actor.user_id)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        json!({"requestId":id,"userId":actor.user_id,"workspaceId":wid,"status":"not_transferred"})
    };
    live(&state, &actor).await?;
    tx.commit().await?;
    live(&state, &actor).await?;
    Ok(Json(response))
}
