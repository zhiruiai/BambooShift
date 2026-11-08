use crate::{
    accounts,
    db::{State, now},
    error::{self, ApiError, Body, Result},
    password, security, sessions,
};
use axum::{
    Json,
    extract::{ConnectInfo, State as Extract},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde_json::{Value, json};
use std::net::SocketAddr;

pub async fn session(Extract(state): Extract<State>, headers: HeaderMap) -> Result<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let identity = sessions::read(&mut conn, &state, &headers, "operator").await?;
    let required =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE platform_role='admin'")
            .fetch_one(&mut *conn)
            .await?
            == 0;
    let mut value = json!({"authenticated":identity.is_some(),"setupRequired":required});
    if let Some(identity) = identity {
        sessions::require(&mut conn, &state, &headers, "operator").await?;
        value["user"] = identity.user.public();
    }
    Ok(Json(value))
}
pub async fn login(
    Extract(state): Extract<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Response> {
    accounts::login_as(&state, peer, &headers, body, "operator").await
}
pub async fn logout(Extract(state): Extract<State>, headers: HeaderMap) -> Result<Response> {
    accounts::logout_as(&state, &headers, "operator").await
}
pub async fn setup(
    Extract(state): Extract<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Response> {
    security::rate_limit(&state, peer, "setup").await?;
    let code = body["code"].as_str().unwrap_or("").trim();
    let expected =
        sqlx::query_scalar::<_, String>("SELECT value FROM platform_meta WHERE key='setup_hash'")
            .fetch_optional(&state.pool)
            .await?;
    let exists =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE platform_role='admin'")
            .fetch_one(&state.pool)
            .await?;
    if exists != 0
        || !expected
            .as_ref()
            .is_some_and(|e| password::digest(code) == *e)
    {
        return Err(ApiError::new(403, "初始化码无效或平台已经初始化。"));
    }
    let address = error::email(&body["email"])?;
    let name = error::text(&body["name"], "姓名", 60)?;
    let hash = password::hash(&state, error::password(&body["password"])?).await?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let current =
        sqlx::query_scalar::<_, String>("SELECT value FROM platform_meta WHERE key='setup_hash'")
            .fetch_optional(&mut *tx)
            .await?;
    let exists =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE platform_role='admin'")
            .fetch_one(&mut *tx)
            .await?;
    if exists != 0 || current != expected {
        return Err(ApiError::new(409, "平台初始化状态已变化。"));
    }
    let user = accounts::insert_user(&mut tx, address, name, hash, true).await?;
    let legacy=sqlx::query_scalar::<_,String>("SELECT id FROM workspaces WHERE storage_key='legacy' AND NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=workspaces.id)").fetch_optional(&mut *tx).await?;
    if let Some(id) = legacy {
        sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',?)")
            .bind(id)
            .bind(&user.id)
            .bind(now())
            .execute(&mut *tx)
            .await?;
    } else {
        accounts::new_workspace(
            &mut tx,
            &user.id,
            &format!("{}的个人空间", user.name),
            "personal",
        )
        .await?;
    }
    sqlx::query("DELETE FROM platform_meta WHERE key='setup_hash'")
        .execute(&mut *tx)
        .await?;
    let cookie = sessions::issue(&mut tx, &state, &headers, &user, "operator").await?;
    tx.commit().await?;
    // The durable consumed hash is authoritative even if file cleanup fails.
    let _ = std::fs::remove_file(state.config.data_dir.join("platform/operator-setup-code"));
    Ok(accounts::json_cookie(
        StatusCode::CREATED,
        json!({"authenticated":true,"setupRequired":false,"user":user.public()}),
        cookie,
    ))
}
