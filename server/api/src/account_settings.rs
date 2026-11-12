use crate::{
    db::{State, iso, now},
    error::{self, ApiError, Body, Result},
    password, security, sessions,
};
use axum::{
    Json,
    extract::{ConnectInfo, Path, State as Extract},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::net::SocketAddr;

pub async fn profile(
    Extract(state): Extract<State>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    error::only_fields(&body, &["name", "expectedUserId"])?;
    let name = error::text(&body["name"], "姓名", 60)?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut identity = sessions::require(&mut tx, &state, &headers, "account").await?;
    sessions::expected_body(&body, &identity)?;
    sqlx::query("UPDATE users SET name=? WHERE id=?")
        .bind(&name)
        .bind(&identity.user.id)
        .execute(&mut *tx)
        .await?;
    identity.user.name = name;
    let value = sessions::account_state(&mut tx, &identity.user).await?;
    tx.commit().await?;
    Ok(Json(value))
}
pub async fn change_password(
    Extract(state): Extract<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Response> {
    error::only_fields(&body, &["currentPassword", "newPassword", "expectedUserId"])?;
    let new = error::password(&body["newPassword"])?;
    let old = body["currentPassword"]
        .as_str()
        .filter(|s| s.encode_utf16().count() <= 128)
        .unwrap_or("")
        .to_owned();
    let identity = {
        let mut conn = state.pool.acquire().await?;
        sessions::require(&mut conn, &state, &headers, "account").await?
    };
    sessions::expected_body(&body, &identity)?;
    security::rate_limit(&state, peer, "account-password").await?;
    if identity.user.local_only() {
        return Err(ApiError::bad("本机个人空间无需密码。"));
    }
    if !password::check(&state, old.clone(), &identity.user.password_hash).await? {
        return Err(ApiError::bad("当前密码不正确。"));
    }
    if old == new {
        return Err(ApiError::bad("新密码不能与当前密码相同。"));
    }
    let hash = password::hash(&state, new).await?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let current = sessions::require(&mut tx, &state, &headers, "account").await?;
    if current.session_id != identity.session_id
        || current.user.password_hash != identity.user.password_hash
    {
        return Err(ApiError::new(409, "账户状态已变化，请重新登录。"));
    }
    let clear_operator = sessions::read(&mut tx, &state, &headers, "operator")
        .await?
        .is_some_and(|i| i.user.id == identity.user.id);
    sqlx::query("UPDATE users SET password_hash=? WHERE id=?")
        .bind(hash)
        .bind(&identity.user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
        .bind(&identity.user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.changed(Some(identity.user.id), None, None);
    let mut response = StatusCode::NO_CONTENT.into_response();
    security::with_cookie(response.headers_mut(), state.config.cookie("account", ""));
    if clear_operator {
        security::with_cookie(response.headers_mut(), state.config.cookie("operator", ""));
    }
    Ok(response)
}
pub async fn list_sessions(
    Extract(state): Extract<State>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let current = sessions::require(&mut conn, &state, &headers, "account").await?;
    let rows = sqlx::query("SELECT id,name,created_at FROM account_sessions WHERE user_id=? AND purpose='account' AND expires_at>? ORDER BY created_at DESC")
        .bind(&current.user.id).bind(now()).fetch_all(&mut *conn).await?;
    let sessions: Vec<Value> = rows.into_iter().map(|r| { let id: String = r.get("id"); let time = iso(r.get("created_at")); json!({"id":id,"name":r.get::<String,_>("name"),"createdAt":time,"lastSeenAt":time,"current":id == current.session_id}) }).collect();
    Ok(Json(json!({"userId":current.user.id,"sessions":sessions})))
}
pub async fn revoke_session(
    Extract(state): Extract<State>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Response> {
    error::only_fields(&body, &["expectedUserId"])?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let current = sessions::require(&mut tx, &state, &headers, "account").await?;
    sessions::expected_body(&body, &current)?;
    sqlx::query("DELETE FROM account_sessions WHERE id=? AND user_id=?")
        .bind(&id)
        .bind(&current.user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.changed(Some(current.user.id), None, Some(id.clone()));
    let mut response = Json(json!({"ok":true})).into_response();
    if current.session_id == id {
        security::with_cookie(response.headers_mut(), state.config.cookie("account", ""));
    }
    Ok(response)
}
