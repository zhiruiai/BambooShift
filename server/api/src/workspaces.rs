use crate::{
    accounts,
    db::{State, iso, now},
    error::{self, ApiError, Body, Result},
    models::Workspace,
    sessions,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

pub(crate) async fn membership(
    conn: &mut SqliteConnection,
    user: &str,
    id: &str,
    owner: bool,
    team: bool,
) -> Result<Workspace> {
    let workspace = sqlx::query_as::<_, Workspace>("SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? AND w.id=? AND w.status='active'")
        .bind(user).bind(id).fetch_optional(conn).await?.ok_or_else(|| ApiError::new(403,"你没有访问此工作空间的权限。"))?;
    if owner && workspace.role != "owner" {
        return Err(ApiError::new(403, "只有空间拥有者可以管理这项设置。"));
    }
    if team && workspace.kind != "team" {
        return Err(ApiError::bad("个人空间不支持团队成员管理。"));
    }
    Ok(workspace)
}
pub async fn create(
    Extract(state): Extract<State>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let name = error::text(&body["name"], "团队名称", 80)?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    let id = accounts::new_workspace(&mut tx, &identity.user.id, &name, "team").await?;
    let value = membership(&mut tx, &identity.user.id, &id, true, true)
        .await?
        .public();
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(value)))
}
pub async fn rename(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let name = error::text(&body["name"], "空间名称", 80)?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    let mut workspace = membership(&mut tx, &identity.user.id, &id, true, false).await?;
    sqlx::query("UPDATE workspaces SET name=? WHERE id=?")
        .bind(&name)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    workspace.name = name;
    tx.commit().await?;
    Ok(Json(workspace.public()))
}
pub async fn team(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    let workspace = membership(&mut tx, &identity.user.id, &id, false, true).await?;
    let rows = sqlx::query("SELECT u.id,u.email,u.name,u.status,m.role,m.joined_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.joined_at")
        .bind(&id).fetch_all(&mut *tx).await?;
    let members: Vec<Value> = rows.iter().map(|r| json!({"userId":r.get::<String,_>("id"),"email":r.get::<String,_>("email"),"name":r.get::<String,_>("name"),"status":r.get::<String,_>("status"),"role":r.get::<String,_>("role"),"joinedAt":iso(r.get("joined_at"))})).collect();
    let mut invitations = Vec::new();
    if workspace.role == "owner" {
        for r in sqlx::query("SELECT id,created_at,expires_at,used_at,revoked_at FROM invitations WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").bind(&id).fetch_all(&mut *tx).await? {
            let status = if r.get::<Option<i64>,_>("revoked_at").is_some() { "revoked" } else if r.get::<Option<i64>,_>("used_at").is_some() { "used" } else if r.get::<i64,_>("expires_at")<=now() { "expired" } else { "pending" };
            invitations.push(json!({"id":r.get::<String,_>("id"),"createdAt":iso(r.get("created_at")),"expiresAt":iso(r.get("expires_at")),"status":status}));
        }
    }
    tx.commit().await?;
    Ok(Json(
        json!({"workspace":workspace.public(),"members":members,"invitations":invitations}),
    ))
}
pub async fn remove_member(
    Extract(state): Extract<State>,
    Path((id, user)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    let workspace = membership(&mut tx, &identity.user.id, &id, false, true).await?;
    if workspace.role != "owner" && identity.user.id != user {
        return Err(ApiError::new(403, "只有空间拥有者可以移除其他成员。"));
    }
    let role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
    )
    .bind(&id)
    .bind(&user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::new(404, "成员不存在。"))?;
    if role == "owner" {
        return Err(ApiError::new(409, "不能移除空间拥有者。"));
    }
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&id)
        .bind(&user)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.changed(Some(user), Some(id), None);
    Ok(Json(json!({"ok":true})))
}
