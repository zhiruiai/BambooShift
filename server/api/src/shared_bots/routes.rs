use super::{
    catalog, references,
    store::{unavailable, uuid},
};
use crate::{
    db::{State, now},
    error::{ApiError, Body, Result},
    sessions,
    workspace::{self, WorkspaceAccess},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State as Extract},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone)]
pub(crate) struct Actor {
    pub id: String,
    session: String,
}
impl Actor {
    pub async fn require(state: &State, headers: &HeaderMap) -> Result<Self> {
        let identity =
            sessions::require(&mut *state.pool.acquire().await?, state, headers, "account").await?;
        if headers
            .get("x-openbot-expected-user")
            .and_then(|h| h.to_str().ok())
            != Some(identity.user.id.as_str())
        {
            return Err(ApiError::new(403, "请确认当前账户后重试。"));
        }
        Ok(Self {
            id: identity.user.id,
            session: identity.session_id,
        })
    }
    pub async fn authorize(&self, state: &State) -> Result<()> {
        state.shared_bots.ensure_open()?;
        let valid:Option<i64>=sqlx::query_scalar("SELECT 1 FROM account_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.purpose='account' AND s.expires_at>? AND u.status='active'").bind(&self.session).bind(&self.id).bind(now()).fetch_optional(&state.pool).await?;
        if valid.is_none() {
            return Err(unavailable());
        }
        Ok(())
    }
}
pub(crate) async fn owner(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
) -> Result<WorkspaceAccess> {
    workspace::access::require(state, headers, wid, true, true).await
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Options {
    pub team_id: Option<String>,
    pub personal_workspace_id: Option<String>,
    pub revision: Option<String>,
    pub query: Option<String>,
}
pub fn router() -> Router<State> {
    Router::new()
        .route("/api/shared-bots", get(directory))
        .route("/api/shared-bots/{id}", get(one))
        .route("/api/shared-bots/{id}/avatar", get(avatar))
        .route(
            "/api/workspaces/{wid}/agents/{agent}/sharing",
            get(sharing).put(update),
        )
        .route(
            "/api/workspaces/{wid}/agents/{agent}/sharing/revoke",
            post(revoke),
        )
        .route("/api/workspaces/{wid}/shared-bot-references", post(add))
        .route(
            "/api/workspaces/{wid}/shared-bot-references/{request}",
            get(receipt),
        )
        .merge(super::resources_http::router())
        .layer(DefaultBodyLimit::max(600 * 1024))
}
async fn directory(
    Extract(state): Extract<State>,
    headers: HeaderMap,
    Query(query): Query<Options>,
) -> Result<Json<Value>> {
    let actor = Actor::require(&state, &headers).await?;
    let mut values = catalog::list_visible(&state, &actor.id, query.team_id.as_deref()).await?;
    if let Some(wid) = &query.personal_workspace_id {
        let grant = owner(&state, &headers, wid).await?;
        let joined = references::joined(&state, &grant).await?;
        for value in &mut values {
            if let Some(joined) = joined.get(value["id"].as_str().unwrap_or("")) {
                value["joined"] = joined.clone();
            }
        }
    }
    actor.authorize(&state).await?;
    Ok(Json(json!(values)))
}
async fn one(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = Actor::require(&state, &headers).await?;
    let definition = catalog::definition(&state, &actor.id, &id).await?;
    actor.authorize(&state).await?;
    Ok(Json(catalog::card(&definition)))
}
async fn avatar(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<Options>,
) -> Result<axum::response::Response> {
    use axum::response::IntoResponse;
    let actor = Actor::require(&state, &headers).await?;
    if !super::resources::revision(&json!(query.revision)) {
        return Err(ApiError::bad("共享头像版本无效。"));
    }
    let definition = catalog::definition(&state, &actor.id, &id).await?;
    if query.revision.as_deref() != Some(&definition.source.revision) {
        return Err(ApiError::new(409, "来源头像已变化，请刷新。"));
    }
    let bytes = definition
        .source
        .avatar
        .ok_or_else(|| ApiError::new(404, "Bot没有图片头像。"))?;
    actor.authorize(&state).await?;
    Ok((
        [
            ("Content-Type", "image/webp"),
            ("Cache-Control", "private, no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
async fn sharing(
    Extract(state): Extract<State>,
    Path((wid, agent)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = owner(&state, &headers, &wid).await?;
    let value = catalog::sharing(&state, &grant, &agent).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
async fn apply(
    state: State,
    wid: String,
    agent: String,
    headers: HeaderMap,
    body: Value,
    revoke: bool,
) -> Result<Json<Value>> {
    let grant = owner(&state, &headers, &wid).await?;
    if let Err(error) = catalog::mutate(&state, &grant, &agent, &body, revoke).await {
        if [400, 409, 413, 422].contains(&error.status.as_u16())
            && state
                .shared_bots
                .request_not_applied(&grant.user_id, &body["requestId"])
                .await
        {
            return Err(error.with_code("SHARED_BOT_NOT_APPLIED"));
        }
        return Err(error);
    }
    grant.authorize_owner(&state).await?;
    let value = catalog::sharing(&state, &grant, &agent).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
async fn update(
    Extract(state): Extract<State>,
    Path((wid, agent)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    apply(state, wid, agent, headers, body, false).await
}
async fn revoke(
    Extract(state): Extract<State>,
    Path((wid, agent)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    apply(state, wid, agent, headers, body, true).await
}
async fn add(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = owner(&state, &headers, &wid).await?;
    let value = match references::add(&state, &grant, &body).await {
        Ok(value) => value,
        Err(error) => {
            if [400, 409, 413, 422].contains(&error.status.as_u16())
                && body["requestId"].as_str().is_some_and(uuid)
            {
                if let Ok(None) =
                    references::peek_receipt(&state, &grant, body["requestId"].as_str().unwrap())
                        .await
                {
                    return Err(error.with_code("SHARED_BOT_NOT_ADDED"));
                }
            }
            return Err(error);
        }
    };
    grant.authorize_owner(&state).await?;
    Ok((StatusCode::CREATED, Json(value)))
}
async fn receipt(
    Extract(state): Extract<State>,
    Path((wid, request)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = owner(&state, &headers, &wid).await?;
    let value = references::peek_receipt(&state, &grant, &request)
        .await?
        .ok_or_else(|| ApiError::new(404, "未找到加入请求的回执。"))?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
