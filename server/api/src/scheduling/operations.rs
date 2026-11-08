use super::{execution, operation_store as ledger, routines};
use crate::{
    agent::{admission::Reservation, authority::ExecutionAccess},
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields},
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};

pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    ledger::request_id(&json!(id))?;
    let store = grant.store(&state).await?;
    let mut conn = store.pool.acquire().await?;
    let value = if let Some((_, receipt)) = ledger::saved(&mut conn, &grant, &id).await? {
        ledger::view(&mut conn, &grant, receipt).await?
    } else if ledger::closed(&mut conn, &grant, &id).await? {
        return Err(
            ApiError::new(410, "这次未接纳的请求已结束。").with_code("ROUTINE_OPERATION_CLOSED")
        );
    } else {
        return Err(ApiError::new(404, "没有找到这次例行任务的提交记录。")
            .with_code("ROUTINE_OPERATION_NOT_FOUND"));
    };
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn cancel(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    if state.is_closing() || state.agent_runs.is_closed() {
        return Err(ApiError::new(503, "服务正在关闭。"));
    }
    if let Some(Json(value)) = body {
        only_fields(&value, &[])?;
    }
    ledger::request_id(&json!(id))?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let value = if let Some((_, receipt)) = ledger::saved(&mut tx, &grant, &id).await? {
        ledger::view(&mut tx, &grant, receipt).await?
    } else {
        sqlx::query("INSERT OR IGNORE INTO routine_operation_cancellations(actor_id,request_id) VALUES(?,?)").bind(ledger::actor(&grant)).bind(&id).execute(&mut *tx).await?;
        json!({"requestId":id,"status":"not_submitted","userId":grant.user_id,"workspaceId":wid})
    };
    grant.authorize_owner(&state).await?;
    if state.is_closing() || state.agent_runs.is_closed() {
        return Err(ApiError::new(503, "服务正在关闭。"));
    }
    tx.commit().await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn submit(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let result = submit_owned(&state, &wid, &grant, &body).await;
    if let Err(error) = result {
        if [400, 409, 413, 422].contains(&error.status.as_u16())
            && error.code != "ROUTINE_OPERATION_CLOSED"
            && !state.is_closing()
            && ledger::request_id(&body["requestId"]).is_ok()
        {
            grant.authorize_owner(&state).await?;
            let store = grant.store(&state).await?;
            let mut tx = store.begin().await?;
            let exists =
                sqlx::query("SELECT 1 FROM routine_operations WHERE actor_id=? AND request_id=?")
                    .bind(ledger::actor(&grant))
                    .bind(body["requestId"].as_str())
                    .fetch_optional(&mut *tx)
                    .await?
                    .is_some();
            grant.authorize_owner(&state).await?;
            tx.rollback().await?;
            if !exists {
                return Err(error.with_code("ROUTINE_OPERATION_NOT_STARTED"));
            }
        }
        return Err(error);
    }
    result
}
async fn submit_owned(
    state: &State,
    wid: &str,
    grant: &crate::workspace::WorkspaceAccess,
    body: &Value,
) -> Result<(StatusCode, Json<Value>)> {
    if state.is_closing() || state.agent_runs.is_closed() {
        return Err(ApiError::new(503, "服务正在关闭。"));
    }
    let kind = body["kind"].as_str().unwrap_or("");
    only_fields(
        &body,
        match kind {
            "create" => &[
                "kind",
                "requestId",
                "agentId",
                "conversationId",
                "title",
                "prompt",
                "schedule",
                "timeZone",
                "enabled",
                super::public_research::QUERIES,
            ],
            "run" => &["kind", "requestId", "routineId", "expectedRoutine"],
            _ => return Err(ApiError::bad("例行任务操作无效。")),
        },
    )?;
    let id = ledger::request_id(&body["requestId"])?;
    let digest = ledger::digest(body)?;
    // Acquire admission before SQLite, matching computer maintenance lock order.
    let _admission = state.agent_runs.admission(wid).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    if let Some(prior) = ledger::prior(&mut tx, &grant, &id, &digest).await? {
        grant.authorize_owner(&state).await?;
        return Ok((StatusCode::OK, Json(prior)));
    }
    ledger::assert_open(&mut tx, &grant, &id).await?;
    let at = now();
    let access = ExecutionAccess::User(grant.clone());
    let mut reservation = None;
    let mut input = None;
    let receipt = if kind == "create" {
        let mut config = body.clone();
        let object = config.as_object_mut().unwrap();
        object.remove("kind");
        object.remove("requestId");
        // Omitted defaults remain omitted in the digest; later default changes cannot alter replay identity.
        if config.get("schedule").is_some_and(|v| !v.is_string()) {
            return Err(ApiError::bad("任务频率无效。"));
        }
        let routine = routines::save_owned(&mut tx, &config, None, at, &grant.user_id).await?;
        json!({"kind":"create","status":"created","requestId":id,"routineId":routine["id"],"agentId":routine["agentId"],"conversationId":routine["conversationId"],"createdAt":iso(at),"userId":grant.user_id,"workspaceId":wid})
    } else {
        let routine_id = body["routineId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("例行任务标识无效。"))?;
        let current = WorkspaceStore::get_in(&mut tx, Table::Routines, routine_id)
            .await?
            .ok_or_else(|| {
                ApiError::new(409, "例行任务已不存在。").with_code("ROUTINE_OPERATION_CHANGED")
            })?;
        if routines::config(&current) != body["expectedRoutine"] {
            return Err(
                ApiError::new(409, "任务配置已变化，请核对后重新确认立即运行。")
                    .with_code("ROUTINE_OPERATION_CHANGED"),
            );
        }
        let aid = current["agentId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("Bot 无效。"))?;
        let cid = current["conversationId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("会话无效。"))?;
        let mid = uuid::Uuid::new_v4().to_string();
        let admitted =
            Reservation::reserve_kind(&state, &access, cid, aid, &mid, "routine").await?;
        let (saved, next) = execution::persist_run(
            &mut tx,
            &current,
            &access,
            false,
            at,
            &mid,
            &admitted.active.run_id,
            Some(&id),
        )
        .await?;
        let receipt = json!({"kind":"run","status":"submitted","requestId":id,"routineId":routine_id,"agentId":aid,"conversationId":cid,"messageId":mid,"createdAt":iso(at),"nextRunAt":next,"userId":grant.user_id,"workspaceId":wid});
        reservation = Some(admitted);
        input = Some(saved);
        receipt
    };
    ledger::insert(&mut tx, &grant, &digest, &receipt).await?;
    grant.authorize_owner(&state).await?;
    if state.is_closing() || state.agent_runs.is_closed() {
        return Err(ApiError::new(503, "服务正在关闭。"));
    }
    tx.commit().await?;
    if let (Some(reservation), Some(input)) = (reservation, input) {
        store.emit("message", input.clone());
        reservation.launch(state.clone(), access, store.clone(), input);
    }
    store.emit("update", json!({}));
    grant.authorize_owner(&state).await?;
    Ok((
        if kind == "create" {
            StatusCode::CREATED
        } else {
            StatusCode::ACCEPTED
        },
        Json(receipt),
    ))
}
