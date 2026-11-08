use super::{access, website_projects};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
    password, sessions, workspaces,
};
use axum::{
    Json, Router,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, SemaphorePermit};
use uuid::Uuid;

const MAX_VIEWERS: usize = 80;

pub(crate) struct ReadLimits {
    active: Semaphore,
    window: Mutex<(Instant, usize)>,
}

impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            active: Semaphore::new(24),
            window: Mutex::new((Instant::now(), 0)),
        }
    }
}

impl ReadLimits {
    fn permit(&self) -> Result<SemaphorePermit<'_>> {
        let limited = || {
            ApiError::new(429, "页面读取过于频繁，请稍后重试。")
                .with_code("WEBSITE_SHARE_RATE_LIMIT")
        };
        let permit = self.active.try_acquire().map_err(|_| limited())?;
        let mut window = self.window.lock().map_err(|_| limited())?;
        if window.0.elapsed() >= Duration::from_secs(60) {
            *window = (Instant::now(), 0);
        }
        if window.1 >= 6000 {
            return Err(limited());
        }
        window.1 += 1;
        Ok(permit)
    }
}

pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/workspaces/{wid}/website-projects/{id}/share",
            get(get_share).put(put_share),
        )
        .route("/api/public/website-projects/{token}", get(shared_manifest))
        .route(
            "/api/public/website-projects/{token}/versions/{id}/files/{*path}",
            get(shared_file),
        )
}

fn unavailable() -> ApiError {
    ApiError::new(404, "分享页面不可用。").with_code("WEBSITE_SHARE_NOT_FOUND")
}

fn invalid() -> ApiError {
    ApiError::bad("网站项目分享设置无效。").with_code("WEBSITE_SHARE_INVALID")
}

fn changed() -> ApiError {
    ApiError::new(409, "页面访问权限已变化，请刷新后重试。").with_code("WEBSITE_SHARE_CHANGED")
}

fn forbidden() -> ApiError {
    ApiError::new(403, "只有空间拥有者或项目创建者可以管理分享。")
        .with_code("WEBSITE_SHARE_FORBIDDEN")
}

#[derive(sqlx::FromRow)]
struct Share {
    revision: String,
    token: Option<String>,
    visibility: String,
    version_id: Option<String>,
    viewer_ids: String,
}

impl Share {
    fn projection(&self) -> Result<Value> {
        Ok(json!({
            "visibility": self.visibility, "revision": self.revision,
            "versionId": self.version_id, "viewerIds": viewers(&self.viewer_ids)?,
            "path": self.token.as_ref().map(|token| format!("/pages/{token}")),
        }))
    }
}

fn viewers(raw: &str) -> Result<Vec<String>> {
    serde_json::from_str(raw).map_err(|_| unavailable())
}

fn private() -> Value {
    json!({"visibility":"private","revision":null,"versionId":null,"viewerIds":[],"path":null})
}

async fn share(conn: &mut SqliteConnection, workspace: &str, key: &str) -> Result<Option<Share>> {
    Ok(sqlx::query_as(
        "SELECT revision,token,visibility,version_id,viewer_ids FROM website_project_shares
         WHERE workspace_id=? AND project_key=?",
    )
    .bind(workspace)
    .bind(key)
    .fetch_optional(conn)
    .await?)
}

async fn get_share(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let (key, publisher) = management_scope(&state, &headers, &wid, &id).await?;
    let mut conn = state.pool.acquire().await?;
    manager(&mut conn, &state, &headers, &wid, publisher.as_deref()).await?;
    let value = match share(&mut conn, &wid, &key).await? {
        Some(saved) => saved.projection()?,
        None => private(),
    };
    Ok(Json(value))
}

async fn management_scope(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
    id: &str,
) -> Result<(String, Option<String>)> {
    let grant = access::require(state, headers, wid, false, true).await?;
    let store = grant.store(state).await?;
    let scope = website_projects::share_scope(&mut *store.pool.acquire().await?, id).await?;
    if !grant.is_owner && scope.1.as_deref() != Some(grant.user_id.as_str()) {
        return Err(forbidden());
    }
    Ok(scope)
}

async fn manager(
    conn: &mut SqliteConnection,
    state: &State,
    headers: &HeaderMap,
    wid: &str,
    publisher: Option<&str>,
) -> Result<String> {
    let identity = sessions::require(conn, state, headers, "account").await?;
    let workspace = workspaces::membership(conn, &identity.user.id, wid, false, false).await?;
    if workspace.role != "owner" && publisher != Some(identity.user.id.as_str()) {
        return Err(forbidden());
    }
    Ok(workspace.kind)
}

struct Change<'a> {
    visibility: &'a str,
    expected: Option<&'a str>,
    viewers: Vec<String>,
    rotate: bool,
}

impl<'a> Change<'a> {
    fn parse(body: &'a Value) -> Result<Self> {
        only_fields(
            body,
            &["visibility", "expectedRevision", "viewerIds", "rotate"],
        )?;
        let visibility = body["visibility"]
            .as_str()
            .filter(|mode| matches!(*mode, "private" | "invited" | "team" | "public"))
            .ok_or_else(invalid)?;
        let expected = match body.get("expectedRevision") {
            Some(Value::Null) => None,
            Some(Value::String(id))
                if Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == *id) =>
            {
                Some(id.as_str())
            }
            _ => return Err(invalid()),
        };
        let mut viewers: Vec<String> = match body.get("viewerIds") {
            None => Vec::new(),
            Some(value) => serde_json::from_value(value.clone()).map_err(|_| invalid())?,
        };
        if viewers.len() > MAX_VIEWERS
            || (visibility != "invited" && !viewers.is_empty())
            || viewers.iter().any(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            })
        {
            return Err(invalid());
        }
        viewers.sort_unstable();
        viewers.dedup();
        let rotate = body
            .get("rotate")
            .map(|value| value.as_bool().ok_or_else(invalid))
            .transpose()?
            .unwrap_or(false);
        if rotate && visibility == "private" {
            return Err(invalid());
        }
        Ok(Self {
            visibility,
            expected,
            viewers,
            rotate,
        })
    }
}

async fn put_share(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let change = Change::parse(&body)?;
    let (key, publisher) = management_scope(&state, &headers, &wid, &id).await?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let kind = manager(&mut tx, &state, &headers, &wid, publisher.as_deref()).await?;
    if kind != "team" && matches!(change.visibility, "team" | "invited") {
        return Err(invalid());
    }
    let previous = share(&mut tx, &wid, &key).await?;
    if previous.as_ref().map(|saved| saved.revision.as_str()) != change.expected {
        return Err(changed());
    }
    let viewer_ids = json!(change.viewers).to_string();
    if !change.viewers.is_empty() {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM memberships m JOIN users u ON u.id=m.user_id
             WHERE m.workspace_id=? AND u.status='active' AND u.id IN (SELECT value FROM json_each(?))",
        )
        .bind(&wid)
        .bind(&viewer_ids)
        .fetch_one(&mut *tx)
        .await?;
        if count as usize != change.viewers.len() {
            return Err(invalid());
        }
    }
    let version_id = (change.visibility != "private").then_some(id);
    if let Some(saved) = previous.as_ref().filter(|saved| {
        !change.rotate
            && saved.visibility == change.visibility
            && saved.version_id == version_id
            && saved.viewer_ids == viewer_ids
    }) {
        tx.commit().await?;
        return Ok(Json(saved.projection()?));
    }
    if previous.is_none() && change.visibility == "private" {
        tx.commit().await?;
        return Ok(Json(private()));
    }
    let token = version_id.as_ref().map(|_| {
        previous
            .and_then(|saved| (!change.rotate).then_some(saved.token).flatten())
            .unwrap_or_else(password::token)
    });
    let updated = Share {
        revision: Uuid::new_v4().to_string(),
        token,
        visibility: change.visibility.to_owned(),
        version_id,
        viewer_ids,
    };
    sqlx::query(
        "INSERT INTO website_project_shares(workspace_id,project_key,publisher_id,revision,token,visibility,version_id,viewer_ids)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,project_key) DO UPDATE SET publisher_id=excluded.publisher_id,
           revision=excluded.revision,token=excluded.token,visibility=excluded.visibility,
           version_id=excluded.version_id,viewer_ids=excluded.viewer_ids",
    )
    .bind(&wid)
    .bind(&key)
    .bind(publisher.as_deref())
    .bind(&updated.revision)
    .bind(&updated.token)
    .bind(&updated.visibility)
    .bind(&updated.version_id)
    .bind(&updated.viewer_ids)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(updated.projection()?))
}

struct Viewer {
    workspace: String,
    storage: String,
    version: String,
    revision: String,
}

async fn viewer(state: &State, headers: &HeaderMap, token: &str) -> Result<Viewer> {
    if !password::valid_token(token) {
        return Err(unavailable());
    }
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        "SELECT w.id,w.storage_key,s.version_id,s.revision,s.visibility,s.viewer_ids,s.publisher_id
         FROM website_project_shares s JOIN workspaces w ON w.id=s.workspace_id
         WHERE s.token=? AND s.visibility<>'private' AND s.version_id IS NOT NULL AND w.status='active'",
    )
    .bind(token)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(unavailable)?;
    let workspace: String = row.try_get("id")?;
    let mode: &str = row.try_get("visibility")?;
    if mode != "public" {
        let identity = sessions::require(&mut tx, state, headers, "account")
            .await
            .map_err(|error| {
                if error.status == StatusCode::UNAUTHORIZED {
                    error.with_code("WEBSITE_SHARE_SIGN_IN")
                } else {
                    error
                }
            })?;
        let role: Option<String> =
            sqlx::query_scalar("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?")
                .bind(&workspace)
                .bind(&identity.user.id)
                .fetch_optional(&mut *tx)
                .await?;
        let publisher: Option<&str> = row.try_get("publisher_id")?;
        if role.is_none()
            || (mode == "invited"
                && role.as_deref() != Some("owner")
                && publisher != Some(identity.user.id.as_str())
                && !viewers(row.try_get("viewer_ids")?)?.contains(&identity.user.id))
        {
            return Err(unavailable());
        }
    }
    let viewer = Viewer {
        workspace,
        storage: row.try_get("storage_key")?,
        version: row.try_get("version_id")?,
        revision: row.try_get("revision")?,
    };
    tx.commit().await?;
    Ok(viewer)
}

async fn shared_manifest(
    Extract(state): Extract<State>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let _permit = state.website_share_limits.permit()?;
    let access = viewer(&state, &headers, &token).await?;
    let store = state
        .workspace
        .get(&access.workspace, &access.storage)
        .await?;
    let response =
        website_projects::manifest_response(&mut *store.pool.acquire().await?, &access.version)
            .await?;
    recheck(&state, &headers, &token, &access).await?;
    Ok(response)
}

async fn shared_file(
    Extract(state): Extract<State>,
    Path((token, version, path)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let _permit = state.website_share_limits.permit()?;
    let access = viewer(&state, &headers, &token).await?;
    if access.version != version {
        return Err(unavailable());
    }
    let store = state
        .workspace
        .get(&access.workspace, &access.storage)
        .await?;
    let response =
        website_projects::asset_response(&mut *store.pool.acquire().await?, &version, &path)
            .await?;
    recheck(&state, &headers, &token, &access).await?;
    Ok(response)
}

async fn recheck(state: &State, headers: &HeaderMap, token: &str, access: &Viewer) -> Result<()> {
    let current = viewer(state, headers, token).await?;
    if current.revision != access.revision || current.storage != access.storage {
        return Err(changed());
    }
    Ok(())
}
