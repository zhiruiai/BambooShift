use super::policies;
use crate::{
    db::State,
    error::{Body, Result},
    workspace::access,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
pub async fn options(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value = policies::options(&store, &id).await?;
    actor.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn list(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value = policies::list(&store, &id).await?;
    actor.authorize_owner(&state).await?;
    Ok(Json(json!(value)))
}
pub async fn create(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let value = policies::create(&state, &store, &actor, &id, &body).await?;
    actor.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn revoke(
    Extract(state): Extract<State>,
    Path((wid, id, policy)): Path<(String, String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    crate::error::only_fields(&body, &[])?;
    let store = actor.store(&state).await?;
    let value = policies::revoke(&state, &store, &actor, &id, &policy).await?;
    actor.authorize_owner(&state).await?;
    Ok(Json(value))
}
