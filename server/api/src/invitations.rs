use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    password, sessions, workspaces,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::{FromRow, SqliteConnection};
use uuid::Uuid;

#[derive(FromRow)]
struct Invitation {
    id: String,
    workspace_id: String,
    workspace_name: String,
    workspace_status: String,
    expires_at: i64,
    used_at: Option<i64>,
    revoked_at: Option<i64>,
}
impl Invitation {
    fn available(&self) -> bool {
        self.workspace_status == "active"
            && self.expires_at > now()
            && self.used_at.is_none()
            && self.revoked_at.is_none()
    }
}
async fn lookup(conn: &mut SqliteConnection, token: &str) -> Result<Invitation> {
    if !password::valid_token(token) {
        return Err(ApiError::new(404, "邀请不存在。"));
    }
    sqlx::query_as::<_,Invitation>("SELECT i.id,i.workspace_id,i.expires_at,i.used_at,i.revoked_at,w.name AS workspace_name,w.status AS workspace_status FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=?")
        .bind(password::digest(token)).fetch_optional(conn).await?.ok_or_else(|| ApiError::new(404,"邀请不存在。"))
}
pub async fn create(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>)> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    workspaces::membership(&mut tx, &identity.user.id, &id, true, true).await?;
    let at = now();
    let pending=sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM invitations WHERE workspace_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").bind(&id).bind(at).fetch_one(&mut *tx).await?;
    if pending >= 50 {
        return Err(ApiError::new(409, "待使用邀请过多，请先撤销旧邀请。"));
    }
    let invite = Uuid::new_v4().to_string();
    let raw = password::token();
    let expires = at + 604_800_000;
    sqlx::query("INSERT INTO invitations(id,token_hash,workspace_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)")
        .bind(&invite).bind(password::digest(&raw)).bind(&id).bind(&identity.user.id).bind(at).bind(expires).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(
            json!({"invitation":{"id":invite,"createdAt":iso(at),"expiresAt":iso(expires),"status":"pending"},"token":raw}),
        ),
    ))
}
pub async fn revoke(
    Extract(state): Extract<State>,
    Path((id, invite)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    workspaces::membership(&mut tx, &identity.user.id, &id, true, true).await?;
    let result=sqlx::query("UPDATE invitations SET revoked_at=? WHERE id=? AND workspace_id=? AND used_at IS NULL AND revoked_at IS NULL").bind(now()).bind(invite).bind(id).execute(&mut *tx).await?;
    if result.rows_affected() != 1 {
        return Err(ApiError::new(404, "邀请不存在或已经使用。"));
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn preview(
    Extract(state): Extract<State>,
    Path(token): Path<String>,
) -> Result<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let invitation = lookup(&mut conn, &token).await?;
    Ok(Json(
        json!({"workspaceName":invitation.workspace_name,"expiresAt":iso(invitation.expires_at),"available":invitation.available()}),
    ))
}
pub async fn accept(
    Extract(state): Extract<State>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    let invitation = lookup(&mut tx, &token).await?;
    if !invitation.available() {
        return Err(ApiError::new(409, "邀请已使用、过期或撤销。"));
    }
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?",
    )
    .bind(&invitation.workspace_id)
    .bind(&identity.user.id)
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_some() {
        return Err(ApiError::new(409, "你已经是这个团队的成员。"));
    }
    sqlx::query("INSERT INTO memberships VALUES(?,?,'member',?)")
        .bind(&invitation.workspace_id)
        .bind(&identity.user.id)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE invitations SET used_at=?,used_by=? WHERE id=?")
        .bind(now())
        .bind(&identity.user.id)
        .bind(&invitation.id)
        .execute(&mut *tx)
        .await?;
    let workspace = workspaces::membership(
        &mut tx,
        &identity.user.id,
        &invitation.workspace_id,
        false,
        true,
    )
    .await?;
    tx.commit().await?;
    state.changed(Some(identity.user.id), Some(invitation.workspace_id), None);
    Ok(Json(workspace.public()))
}
