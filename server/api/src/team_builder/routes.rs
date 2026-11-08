use super::{catalog, draft, mutations, store};
use crate::{
    db::State,
    error::{Body, Result, only_fields},
    workspace::access,
};
use axum::{
    Json,
    extract::{Path, Query, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use std::collections::HashMap;
pub async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let ws = grant.store(&state).await?;
    let rows: Vec<String> = if let Some(request) = query.get("requestId") {
        draft::uuid(&json!(request))?;
        sqlx::query_scalar("SELECT data FROM bot_team_plans WHERE request_id=?")
            .bind(request)
            .fetch_all(&ws.pool)
            .await?
    } else {
        sqlx::query_scalar("SELECT data FROM bot_team_plans ORDER BY rowid DESC LIMIT 20")
            .fetch_all(&ws.pool)
            .await?
    };
    let plans = rows
        .into_iter()
        .map(|r| store::decode(r).map(|v| v["plan"].clone()))
        .collect::<Result<Vec<_>>>()?;
    grant.authorize_owner(&state).await?;
    Ok(Json(json!(plans)))
}
pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let ws = grant.store(&state).await?;
    let value = store::get(&mut *ws.pool.acquire().await?, &id).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value["plan"].clone()))
}
pub async fn cancel(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &[])?;
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let ws = grant.store(&state).await?;
    let value = mutations::cancel(&state, &grant, &ws, &id).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn revise(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let ws = grant.store(&state).await?;
    let value = mutations::revise(&state, &grant, &ws, &id, &body).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn commit(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let ws = grant.store(&state).await?;
    let value = mutations::commit(&state, &grant, &ws, &id, &body).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn review(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let ws = grant.store(&state).await?;
    let value = catalog::preview(&state, &grant, &ws, &id, &body).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn refresh(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let ws = grant.store(&state).await?;
    let value = catalog::refresh(&state, &grant, &ws, &id, &body).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn receipt(
    Extract(state): Extract<State>,
    Path((wid, id, request)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    draft::uuid(&json!(request))?;
    let ws = grant.store(&state).await?;
    let value = catalog::receipt(&mut *ws.pool.acquire().await?, &id, &request).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
