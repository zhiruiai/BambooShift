use crate::{
    db::State,
    error::{Body, Result, only_fields},
    workspace::access,
};
use axum::{
    Json, Router,
    extract::{Path, State as Extract},
    http::HeaderMap,
    routing::get,
};
use serde_json::Value;
pub fn router() -> Router<State> {
    Router::new().route("/api/workspaces/{wid}/updates", get(status).post(check))
}
async fn status(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let mut value = state.updates.status(&state).await;
    grant.authorize(&state).await?;
    value["scope"] = serde_json::json!({"workspaceId":wid,"userId":grant.user_id});
    Ok(Json(value))
}
async fn check(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    only_fields(&body, &[])?;
    let mut value = state.updates.check(&state, &grant).await?;
    grant.authorize(&state).await?;
    value["scope"] = serde_json::json!({"workspaceId":wid,"userId":grant.user_id});
    Ok(Json(value))
}
