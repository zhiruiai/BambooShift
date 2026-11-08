use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result},
    models::User,
    sessions,
};
use axum::{
    Json,
    extract::{Path, Query, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::HashMap;

fn pagination(query: &HashMap<String, String>) -> Result<(i64, String)> {
    let page = match query.get("page") {
        None => 1,
        Some(s) => s
            .parse::<i64>()
            .ok()
            .filter(|n| (1..=100000).contains(n))
            .ok_or_else(|| ApiError::bad("页码无效。"))?,
    };
    let q: String = query
        .get("q")
        .map(String::as_str)
        .unwrap_or("")
        .chars()
        .take(100)
        .collect();
    Ok((
        page,
        format!(
            "%{}%",
            q.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        ),
    ))
}
async fn users_page(conn: &mut SqliteConnection, page: i64, term: &str) -> Result<Value> {
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'",
    )
    .bind(term)
    .bind(term)
    .fetch_one(&mut *conn)
    .await?;
    let rows=sqlx::query_as::<_,User>("SELECT * FROM users WHERE email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' ORDER BY created_at DESC,id LIMIT 50 OFFSET ?").bind(term).bind(term).bind((page-1)*50).fetch_all(conn).await?;
    Ok(
        json!({"items":rows.iter().map(User::public).collect::<Vec<_>>(),"total":total,"page":page,"pageSize":50}),
    )
}
async fn workspaces_page(conn: &mut SqliteConnection, page: i64, term: &str) -> Result<Value> {
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM workspaces WHERE name LIKE ? ESCAPE '\\'",
    )
    .bind(term)
    .fetch_one(&mut *conn)
    .await?;
    let rows=sqlx::query("SELECT w.*,(SELECT COUNT(*) FROM memberships m WHERE m.workspace_id=w.id) AS member_count,(SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=w.id AND m.role='owner') AS owner_name FROM workspaces w WHERE w.name LIKE ? ESCAPE '\\' ORDER BY w.created_at DESC,w.id LIMIT 50 OFFSET ?").bind(term).bind((page-1)*50).fetch_all(conn).await?;
    let items:Vec<Value>=rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"status":r.get::<String,_>("status"),"createdAt":iso(r.get("created_at")),"memberCount":r.get::<i64,_>("member_count"),"ownerName":r.get::<Option<String>,_>("owner_name").unwrap_or("尚未认领".into())})).collect();
    Ok(json!({"items":items,"total":total,"page":page,"pageSize":50}))
}
pub async fn users(
    Extract(state): Extract<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let (page, term) = pagination(&query)?;
    let mut tx = state.pool.begin().await?;
    sessions::require(&mut tx, &state, &headers, "operator").await?;
    let value = users_page(&mut tx, page, &term).await?;
    tx.commit().await?;
    Ok(Json(value))
}
pub async fn workspaces(
    Extract(state): Extract<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let (page, term) = pagination(&query)?;
    let mut tx = state.pool.begin().await?;
    sessions::require(&mut tx, &state, &headers, "operator").await?;
    let value = workspaces_page(&mut tx, page, &term).await?;
    tx.commit().await?;
    Ok(Json(value))
}
pub async fn overview(Extract(state): Extract<State>, headers: HeaderMap) -> Result<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    sessions::require(&mut tx, &state, &headers, "operator").await?;
    let mut counts = serde_json::Map::new();
    for (key, sql) in [
        ("users", "SELECT COUNT(*) FROM users"),
        (
            "activeUsers",
            "SELECT COUNT(*) FROM users WHERE status='active'",
        ),
        (
            "suspendedUsers",
            "SELECT COUNT(*) FROM users WHERE status='suspended'",
        ),
        (
            "personalWorkspaces",
            "SELECT COUNT(*) FROM workspaces WHERE kind='personal'",
        ),
        ("teams", "SELECT COUNT(*) FROM workspaces WHERE kind='team'"),
        (
            "suspendedWorkspaces",
            "SELECT COUNT(*) FROM workspaces WHERE status='suspended'",
        ),
    ] {
        counts.insert(
            key.into(),
            json!(
                sqlx::query_scalar::<_, i64>(sql)
                    .fetch_one(&mut *tx)
                    .await?
            ),
        );
    }
    let users = users_page(&mut tx, 1, "%").await?;
    let spaces = workspaces_page(&mut tx, 1, "%").await?;
    let first = |value: &Value| {
        value["items"]
            .as_array()
            .unwrap()
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
    };
    tx.commit().await?;
    Ok(Json(
        json!({"generatedAt":iso(now()),"counts":counts,"recentUsers":first(&users),"recentWorkspaces":first(&spaces)}),
    ))
}
fn status(body: &Value) -> Result<&str> {
    body["status"]
        .as_str()
        .filter(|s| ["active", "suspended"].contains(s))
        .ok_or_else(|| ApiError::bad("状态无效。"))
}
pub async fn set_user(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let value = status(&body)?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let actor = sessions::require(&mut tx, &state, &headers, "operator").await?;
    let mut user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::new(404, "账户不存在。"))?;
    if value == "suspended" && (actor.user.id == id || user.platform_role == "admin") {
        return Err(ApiError::new(409, "不能通过用户管理停用运营管理员。"));
    }
    sqlx::query("UPDATE users SET status=? WHERE id=?")
        .bind(value)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if value == "suspended" {
        sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    state.changed(Some(id), None, None);
    user.status = value.into();
    Ok(Json(user.public()))
}
pub async fn set_workspace(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let value = status(&body)?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    sessions::require(&mut tx, &state, &headers, "operator").await?;
    if sqlx::query("UPDATE workspaces SET status=? WHERE id=?")
        .bind(value)
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        != 1
    {
        return Err(ApiError::new(404, "空间不存在。"));
    }
    tx.commit().await?;
    state.changed(None, Some(id), None);
    Ok(Json(json!({"ok":true})))
}
