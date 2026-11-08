use super::{
    actions, connections, oauth, oauth_store,
    runtime::{AppsRuntime, user_authority},
    tool_access,
};
use crate::{
    db::State,
    error::{ApiError, Body, Result},
    workspace::access,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, header},
    response::IntoResponse,
};
use serde_json::{Value, json};
use std::{future::Future, sync::Arc};

pub async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, false, true).await?;
    let store = actor.store(&state).await?;
    let value = connections::list(&store).await?;
    actor.authorize(&state).await?;
    Ok(Json(json!(value)))
}
pub async fn add(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value = connections::add(&state, &store, &body, user_authority(&state, &actor)).await?;
    actor.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn tools(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, false, true).await?;
    let store = actor.store(&state).await?;
    let value = connections::managed_tools(&store, &id).await?;
    actor.authorize(&state).await?;
    Ok(Json(json!(value)))
}
pub async fn tool_access(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value =
        tool_access::update(&state, &store, &id, body, user_authority(&state, &actor)).await?;
    actor.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn reconnect(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value =
        connections::reconnect(&state, &store, &id, &body, user_authority(&state, &actor)).await?;
    actor.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn disconnect(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    remove_connection(state, wid, id, headers, false).await
}
pub async fn remove(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    remove_connection(state, wid, id, headers, true).await
}
async fn remove_connection(
    state: State,
    wid: String,
    id: String,
    headers: HeaderMap,
    remove: bool,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value =
        connections::disconnect(&state, &store, &id, remove, user_authority(&state, &actor))
            .await?;
    actor.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn decide(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let (approve, always) = match (
        body.as_object().map(|m| m.len()),
        body["approve"].as_bool(),
        body["decision"].as_str(),
    ) {
        (Some(1), Some(approve), None) => (approve, false),
        (Some(1), None, Some("always_allow")) => (true, true),
        _ => return Err(ApiError::bad("审批参数无效。")),
    };
    let actor = access::require(&state, &headers, &wid, false, true).await?;
    let store = actor.store(&state).await?;
    let value = if always {
        actions::always_allow(&state, &store, &id, &actor).await?
    } else {
        actions::decide(&state, &store, &id, approve, &actor).await?
    };
    actor.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn oauth_start(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value = oauth_request(state.apps.clone(), async move {
        let value = oauth::start(&state, &store, &actor, &id, &body).await?;
        actor.authorize(&state).await?;
        Ok(value)
    })
    .await?;
    Ok(Json(value))
}

async fn oauth_request(
    runtime: Arc<AppsRuntime>,
    operation: impl Future<Output = Result<Value>> + Send + 'static,
) -> Result<Value> {
    let lease = runtime.enter()?;
    // The initiating window may disappear after the flow was written. Only
    // explicit cancellation, expiry, or the existing authority fences stop it.
    tokio::spawn(async move {
        let _lease = lease;
        operation.await
    })
    .await
    .map_err(|_| ApiError::new(503, "应用授权结果暂不可用，请查看当前授权状态。"))?
}
pub async fn oauth_current(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    Ok(Json(oauth::current(&state, &store, &actor, &id).await?))
}
pub async fn oauth_get(
    Extract(state): Extract<State>,
    Path((wid, id, fid)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    Ok(Json(
        oauth_store::view(&state, &store, &actor, &id, &fid, false).await?,
    ))
}
pub async fn oauth_handoff(
    Extract(state): Extract<State>,
    Path((wid, id, fid)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    Ok(Json(
        oauth_store::view(&state, &store, &actor, &id, &fid, true).await?,
    ))
}
pub async fn oauth_action(
    Extract(state): Extract<State>,
    Path((wid, id, fid, operation)): Path<(String, String, String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<axum::response::Response> {
    if !body.as_object().is_some_and(|m| m.is_empty()) {
        return Err(ApiError::bad("授权参数无效。"));
    }
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let result = match operation.as_str() {
        "launch" => {
            let flow = oauth_store::view(&state, &store, &actor, &id, &fid, false).await?;
            if flow["status"] != "pending" || !flow["launchPath"].is_string() {
                return Err(ApiError::new(409, "此授权暂不能打开，请查看当前状态。"));
            }
            json!({"launchPath":flow["launchPath"]})
        }
        "begin" => {
            let (value, cookie) = oauth::begin(&state, &store, &actor, &id, &fid).await?;
            let mut response = Json(value).into_response();
            response
                .headers_mut()
                .insert(header::SET_COOKIE, cookie.parse().unwrap());
            return Ok(response);
        }
        "finish" => {
            let value = oauth_request(state.apps.clone(), async move {
                let value = oauth::finish(&state, &store, &actor, &id, &fid).await?;
                actor.authorize(&state).await?;
                Ok(value)
            })
            .await?;
            return Ok(Json(value).into_response());
        }
        "cancel" => oauth::cancel(&state, &store, &actor, &id, &fid).await?,
        _ => return Err(ApiError::new(404, "授权操作不存在。")),
    };
    actor.authorize(&state).await?;
    Ok(Json(result).into_response())
}
