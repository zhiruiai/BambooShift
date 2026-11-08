use super::{blueprint, copy_routes, installs, published, store};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
    workspace::access,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State as Extract},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn router() -> Router<State> {
    use axum::routing::get;
    Router::new()
        .route("/api/bot-template-gallery", get(gallery))
        .route("/api/bot-template-links/{token}", get(preview))
        .route("/api/bot-template-links/{token}/avatar", get(avatar))
}
async fn gallery(
    Extract(state): Extract<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let user = published::viewer(&state, &headers).await?;
    let value = published::gallery(
        &state,
        user.as_deref(),
        query.get("query").map(String::as_str).unwrap_or(""),
    )
    .await?;
    if published::viewer(&state, &headers).await? != user {
        return Err(ApiError::new(403, "当前账户已变化。"));
    }
    Ok(Json(value))
}
async fn preview(
    Extract(state): Extract<State>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let user = published::viewer(&state, &headers).await?;
    let value = published::read(&state, &token, user.as_deref())
        .await?
        .value;
    if published::viewer(&state, &headers).await? != user {
        return Err(ApiError::new(403, "当前账户已变化。"));
    }
    Ok(Json(value))
}
fn image(bytes: Option<Vec<u8>>) -> Result<Response> {
    let bytes = bytes.ok_or_else(|| ApiError::new(404, "模板没有图片头像。"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::HeaderName::from_static("cross-origin-resource-policy"),
                "same-origin",
            ),
        ],
        bytes,
    )
        .into_response())
}
async fn avatar(
    Extract(state): Extract<State>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    let expected = query
        .get("revision")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad("请重新读取模板头像版本。"))?;
    let user = published::viewer(&state, &headers).await?;
    let value = published::read(&state, &token, user.as_deref()).await?;
    if value.snapshot.revision != *expected {
        return Err(ApiError::new(409, "模板头像已更新，请重新读取完整预览。")
            .with_code("BOT_TEMPLATE_VERSION_CHANGED"));
    }
    if published::viewer(&state, &headers).await? != user {
        return Err(ApiError::new(403, "当前账户已变化。"));
    }
    image(value.snapshot.avatar)
}
pub async fn draft_avatar(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let value = store::read(&mut *state.bot_templates.pool.acquire().await?, &wid, &id).await?;
    if value.row["draftRevision"].as_str() != query.get("revision").map(String::as_str) {
        return Err(ApiError::new(409, "模板草稿已变化，请重新载入。"));
    }
    grant.authorize_owner(&state).await?;
    image(value.avatar)
}
pub async fn import(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let result = async {
        only_fields(
            &body,
            &[
                "requestId",
                "token",
                "expectedRevision",
                "name",
                "routineMode",
            ],
        )?;
        let id = blueprint::uuid(&body["requestId"])?;
        let token = body["token"]
            .as_str()
            .ok_or_else(|| ApiError::bad("模板链接无效。"))?;
        published::token(token)?;
        let source = json!({"kind":"template","id":token,"revision":body["expectedRevision"]});
        installs::install(
            state.clone(),
            grant.clone(),
            id.to_owned(),
            source,
            body["name"].clone(),
            body["routineMode"].clone(),
        )
        .await
    }
    .await;
    Ok((
        StatusCode::CREATED,
        Json(copy_routes::safe_error(&state, &grant, &body, result).await?),
    ))
}
