use super::{
    catalog, files, resources,
    routes::{Actor, Options, owner},
    source, source_apps,
    store::unavailable,
};
use crate::{
    db::State,
    error::{ApiError, Result},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State as Extract},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/workspaces/{wid}/agents/{agent}/sharing/files",
            get(file_options),
        )
        .route(
            "/api/workspaces/{wid}/agents/{agent}/sharing/files/{file}",
            get(inspect_file),
        )
        .route(
            "/api/workspaces/{wid}/agents/{agent}/sharing/files/{file}/download",
            get(owner_file),
        )
        .route(
            "/api/workspaces/{wid}/agents/{agent}/sharing/apps",
            get(app_options),
        )
        .route(
            "/api/workspaces/{wid}/agents/{agent}/sharing/apps/{app}",
            get(inspect_app),
        )
        .route("/api/shared-bots/{id}/files", get(file_list))
        .route(
            "/api/shared-bots/{id}/files/{file}/download",
            get(recipient_file),
        )
        .route("/api/shared-bots/{id}/apps", get(app_list))
        .route(
            "/api/shared-bots/{id}/apps/{app}/tools",
            get(recipient_tools),
        )
}
async fn source_context(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
    agent: &str,
) -> Result<(
    crate::workspace::WorkspaceAccess,
    source::Workspace,
    Option<super::store::Share>,
)> {
    let grant = owner(state, headers, wid).await?;
    let workspace = catalog::source_owner(state, &grant, agent).await?;
    let share = super::store::SharedBots::source_in(
        &mut *state.shared_bots.pool.acquire().await?,
        wid,
        agent,
    )
    .await?;
    Ok((grant, workspace, share))
}
async fn file_options(
    Extract(state): Extract<State>,
    Path((wid, agent)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<Options>,
) -> Result<Json<Value>> {
    let (grant, workspace, share) = source_context(&state, &headers, &wid, &agent).await?;
    let value = files::options(
        &state,
        &workspace,
        share
            .as_ref()
            .and_then(|s| s.files.as_deref())
            .unwrap_or(&[]),
        query.query.as_deref().unwrap_or(""),
    )
    .await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
async fn inspect_file(
    Extract(state): Extract<State>,
    Path((wid, agent, file)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let (grant, workspace, _) = source_context(&state, &headers, &wid, &agent).await?;
    let (value, _, _) = files::read(&state, &workspace, &file, None).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
fn download(file: files::SharedFile) -> Result<Response> {
    let filename = percent(&file.name);
    let disposition = format!("attachment; filename*=UTF-8''{filename}");
    Ok((
        [
            ("Content-Type", "application/octet-stream"),
            ("Cache-Control", "private, no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("Content-Security-Policy", "sandbox; default-src 'none'"),
            ("Content-Disposition", disposition.as_str()),
        ],
        file.bytes,
    )
        .into_response())
}
fn percent(name: &str) -> String {
    name.as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"._-".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn file_revision(query: &Options) -> Result<&str> {
    if !resources::revision(&json!(query.revision)) {
        return Err(ApiError::bad("共享资料版本无效。"));
    }
    Ok(query.revision.as_deref().unwrap())
}
async fn owner_file(
    Extract(state): Extract<State>,
    Path((wid, agent, file)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(query): Query<Options>,
) -> Result<Response> {
    let (grant, workspace, _) = source_context(&state, &headers, &wid, &agent).await?;
    let (_, file, _) = files::read(&state, &workspace, &file, Some(file_revision(&query)?)).await?;
    grant.authorize_owner(&state).await?;
    download(file)
}
async fn file_list(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = Actor::require(&state, &headers).await?;
    let definition = catalog::definition(&state, &actor.id, &id).await?;
    let workspace = source::workspace(&state, &definition.share.source_workspace_id).await?;
    let values = files::views(
        &state,
        &workspace,
        definition.share.files.as_deref().unwrap_or(&[]),
    )
    .await;
    verify(&state, &actor, &definition.share).await?;
    Ok(Json(json!(values)))
}
async fn verify(state: &State, actor: &Actor, share: &super::store::Share) -> Result<()> {
    let current = state.shared_bots.get(&share.id).await?;
    if current.access_revision != share.access_revision {
        return Err(unavailable());
    }
    catalog::authorize_share(state, &actor.id, &current).await?;
    actor.authorize(state).await
}
async fn recipient_file(
    Extract(state): Extract<State>,
    Path((id, file)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<Options>,
) -> Result<Response> {
    let actor = Actor::require(&state, &headers).await?;
    let definition = catalog::definition(&state, &actor.id, &id).await?;
    let revision = file_revision(&query)?;
    let selected = definition
        .share
        .files
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .find(|f| f["fileId"] == file && f["revision"] == revision)
        .ok_or_else(unavailable)?;
    let workspace = source::workspace(&state, &definition.share.source_workspace_id).await?;
    let (actual, file, _) = files::read(&state, &workspace, &file, Some(revision)).await?;
    if actual != *selected {
        return Err(unavailable());
    }
    verify(&state, &actor, &definition.share).await?;
    download(file)
}
async fn app_options(
    Extract(state): Extract<State>,
    Path((wid, agent)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let (grant, workspace, share) = source_context(&state, &headers, &wid, &agent).await?;
    let value = source_apps::options(
        &state,
        &workspace,
        share
            .as_ref()
            .and_then(|s| s.apps.as_deref())
            .unwrap_or(&[]),
    )
    .await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
async fn inspect_app(
    Extract(state): Extract<State>,
    Path((wid, agent, app)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let (grant, workspace, _) = source_context(&state, &headers, &wid, &agent).await?;
    let value = source_apps::inspect(&state, &workspace, &app).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
async fn app_list(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = Actor::require(&state, &headers).await?;
    let d = catalog::definition(&state, &actor.id, &id).await?;
    let workspace = source::workspace(&state, &d.share.source_workspace_id).await?;
    let values =
        source_apps::views(&state, &workspace, d.share.apps.as_deref().unwrap_or(&[])).await;
    verify(&state, &actor, &d.share).await?;
    Ok(Json(json!(values)))
}
async fn recipient_tools(
    Extract(state): Extract<State>,
    Path((id, app)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = Actor::require(&state, &headers).await?;
    let d = catalog::definition(&state, &actor.id, &id).await?;
    let selected = d
        .share
        .apps
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .find(|a| a["connectionId"] == app)
        .ok_or_else(unavailable)?;
    let workspace = source::workspace(&state, &d.share.source_workspace_id).await?;
    let tools = source_apps::available_tools(&state, &workspace, selected).await?;
    verify(&state, &actor, &d.share).await?;
    Ok(Json(
        json!({"connectionId":app,"name":selected["name"],"connectionRevision":selected["connectionRevision"],"tools":tools}),
    ))
}
