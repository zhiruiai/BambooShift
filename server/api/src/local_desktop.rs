use crate::{
    accounts,
    db::State,
    error::{self, ApiError, Body, Result},
    models::User,
    password, sessions,
};
use axum::{
    extract::{ConnectInfo, State as Extract},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde_json::json;
use std::net::SocketAddr;

pub(crate) const PASSWORD_MARKER: &str = "!bambooshift-local-desktop-v1";

/// Only the app-owned process can exchange its startup secret for a regular account session.
pub async fn session(
    Extract(state): Extract<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Response> {
    let config = state
        .config
        .local_desktop
        .as_ref()
        .ok_or_else(|| ApiError::new(404, "本机免登录模式未启用。"))?;
    let supplied = headers
        .get("x-bambooshift-local-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let valid = supplied.len() == 64
        && headers.get_all("x-bambooshift-local-token").iter().count() == 1
        && password::digest(supplied)
            .bytes()
            .zip(password::digest(&config.bootstrap_token).bytes())
            .fold(0_u8, |different, (a, b)| different | (a ^ b))
            == 0;
    if !peer.ip().is_loopback() || !valid {
        return Err(ApiError::new(403, "请从本机客户端打开这个工作空间。"));
    }
    error::only_fields(&body, &[])?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let existing = sqlx::query_as::<_, User>("SELECT * FROM users WHERE password_hash=?")
        .bind(PASSWORD_MARKER)
        .fetch_optional(&mut *tx)
        .await?;
    let user = if let Some(user) = existing {
        if user.status != "active" || user.platform_role != "user" {
            return Err(ApiError::new(403, "本机账户当前不可用。"));
        }
        user
    } else {
        // Never adopt an existing hosted/team deployment as a passwordless personal profile.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&mut *tx)
            .await?;
        if count != 0 {
            return Err(ApiError::new(409, "本机免登录模式需要独立的个人数据目录。"));
        }
        let user = accounts::insert_user(
            &mut tx,
            "desktop@bambooshift.invalid".into(),
            "Local user".into(),
            PASSWORD_MARKER.into(),
            false,
        )
        .await?;
        accounts::new_workspace(&mut tx, &user.id, "My workspace", "personal").await?;
        user
    };
    let workspace: String = sqlx::query_scalar(
        "SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id=w.id \
         WHERE m.user_id=? AND m.role='owner' AND w.kind='personal' AND w.status='active' \
         ORDER BY w.created_at LIMIT 1",
    )
    .bind(&user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::new(409, "本机工作空间不可用。"))?;
    let cookie = sessions::issue(&mut tx, &state, &headers, &user, "account").await?;
    let mut value = sessions::account_state(&mut tx, &user).await?;
    value["workspaceId"] = json!(workspace);
    tx.commit().await?;
    Ok(accounts::json_cookie(StatusCode::OK, value, cookie))
}
