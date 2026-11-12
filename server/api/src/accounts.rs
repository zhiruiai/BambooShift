use crate::{
    db::{State, now},
    error::{self, ApiError, Body, Result},
    models::User,
    password, security, sessions,
};
use axum::{
    Json,
    extract::{ConnectInfo, State as Extract},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::net::SocketAddr;
use uuid::Uuid;

pub(crate) async fn insert_user(
    conn: &mut SqliteConnection,
    address: String,
    name: String,
    hash: String,
    admin: bool,
) -> Result<User> {
    if sqlx::query_scalar::<_, i64>("SELECT 1 FROM users WHERE email=?")
        .bind(&address)
        .fetch_optional(&mut *conn)
        .await?
        .is_some()
    {
        return Err(ApiError::new(409, "该邮箱已注册，请直接登录。"));
    }
    let user = User {
        id: Uuid::new_v4().to_string(),
        email: address,
        name,
        password_hash: hash,
        status: "active".into(),
        platform_role: if admin { "admin" } else { "user" }.into(),
        created_at: now(),
    };
    sqlx::query("INSERT INTO users VALUES(?,?,?,?,?,?,?)")
        .bind(&user.id)
        .bind(&user.email)
        .bind(&user.name)
        .bind(&user.password_hash)
        .bind(&user.status)
        .bind(&user.platform_role)
        .bind(user.created_at)
        .execute(conn)
        .await?;
    Ok(user)
}
pub(crate) async fn new_workspace(
    conn: &mut SqliteConnection,
    user: &str,
    name: &str,
    kind: &str,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let at = now();
    sqlx::query("INSERT INTO workspaces VALUES(?,?,?,'active',?,?)")
        .bind(&id)
        .bind(name)
        .bind(kind)
        .bind(&id)
        .bind(at)
        .execute(&mut *conn)
        .await?;
    sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',?)")
        .bind(&id)
        .bind(user)
        .bind(at)
        .execute(conn)
        .await?;
    Ok(id)
}
pub async fn session(Extract(state): Extract<State>, headers: HeaderMap) -> Result<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let Some(identity) = sessions::read(&mut conn, &state, &headers, "account").await? else {
        return Ok(Json(json!({"authenticated":false,"workspaces":[]})));
    };
    sessions::require(&mut conn, &state, &headers, "account").await?;
    Ok(Json(
        sessions::account_state(&mut conn, &identity.user).await?,
    ))
}
pub async fn register(
    Extract(state): Extract<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Response> {
    if state.config.local_desktop.is_some() {
        return Err(ApiError::new(
            403,
            "本机个人空间无需注册，请从客户端直接打开。",
        ));
    }
    security::rate_limit(&state, peer, "register").await?;
    let address = error::email(&body["email"])?;
    let name = error::text(&body["name"], "姓名", 60)?;
    let kind = body["kind"].as_str().unwrap_or("");
    if !["personal", "team"].contains(&kind) {
        return Err(ApiError::bad("请选择个人使用或创建团队。"));
    }
    let team = if kind == "team" {
        Some(error::text(&body["teamName"], "团队名称", 80)?)
    } else {
        None
    };
    let hash = password::hash(&state, error::password(&body["password"])?).await?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let user = insert_user(&mut tx, address, name, hash, false).await?;
    let mut id = new_workspace(
        &mut tx,
        &user.id,
        &format!("{}的个人空间", user.name),
        "personal",
    )
    .await?;
    if let Some(team) = team {
        id = new_workspace(&mut tx, &user.id, &team, "team").await?;
    }
    let cookie = sessions::issue(&mut tx, &state, &headers, &user, "account").await?;
    let mut value = sessions::account_state(&mut tx, &user).await?;
    value["workspaceId"] = json!(id);
    tx.commit().await?;
    Ok(json_cookie(StatusCode::CREATED, value, cookie))
}
pub async fn login(
    Extract(state): Extract<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Response> {
    login_as(&state, peer, &headers, body, "account").await
}
pub(crate) async fn login_as(
    state: &State,
    peer: SocketAddr,
    headers: &HeaderMap,
    body: Value,
    purpose: &str,
) -> Result<Response> {
    if state.config.local_desktop.is_some() {
        return Err(ApiError::new(
            403,
            "本机个人空间无需登录，请从客户端直接打开。",
        ));
    }
    security::rate_limit(state, peer, &format!("{purpose}-login")).await?;
    let address = error::email(&body["email"])?;
    let raw = body["password"]
        .as_str()
        .filter(|s| s.encode_utf16().count() <= 128)
        .unwrap_or("")
        .to_owned();
    let previous = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email=?")
        .bind(address)
        .fetch_optional(&state.pool)
        .await?;
    let valid = password::check(
        state,
        raw,
        previous
            .as_ref()
            .map(|u| u.password_hash.as_str())
            .unwrap_or(""),
    )
    .await?;
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let current = if let Some(old) = &previous {
        sqlx::query_as::<_, User>("SELECT * FROM users WHERE id=?")
            .bind(&old.id)
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    let user = current
        .filter(|u| {
            valid
                && u.status == "active"
                && previous
                    .as_ref()
                    .is_some_and(|p| p.password_hash == u.password_hash)
                && (purpose != "operator" || u.platform_role == "admin")
        })
        .ok_or_else(|| ApiError::new(401, "邮箱、密码或账户权限不正确。"))?;
    let cookie = sessions::issue(&mut tx, state, headers, &user, purpose).await?;
    let value = if purpose == "operator" {
        json!({"authenticated":true,"setupRequired":false,"user":user.public()})
    } else {
        let mut value = sessions::account_state(&mut tx, &user).await?;
        value["workspaceId"] = value["workspaces"]
            .as_array()
            .and_then(|a| a.iter().find(|w| w["status"] == "active"))
            .map(|w| w["id"].clone())
            .unwrap_or(json!(""));
        value
    };
    tx.commit().await?;
    Ok(json_cookie(StatusCode::OK, value, cookie))
}
pub async fn logout(Extract(state): Extract<State>, headers: HeaderMap) -> Result<Response> {
    logout_as(&state, &headers, "account").await
}
pub(crate) async fn logout_as(
    state: &State,
    headers: &HeaderMap,
    purpose: &str,
) -> Result<Response> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let current = sessions::read(&mut tx, state, headers, purpose).await?;
    if let Some(identity) = &current {
        sessions::require(&mut tx, state, headers, purpose).await?;
        sqlx::query("DELETE FROM account_sessions WHERE id=?")
            .bind(&identity.session_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if let Some(identity) = current {
        state.changed(Some(identity.user.id), None, Some(identity.session_id));
    }
    Ok(json_cookie(
        StatusCode::OK,
        json!({"ok":true}),
        state.config.cookie(purpose, ""),
    ))
}
pub(crate) fn json_cookie(status: StatusCode, value: Value, cookie: String) -> Response {
    let mut response = (status, Json(value)).into_response();
    security::with_cookie(response.headers_mut(), cookie);
    response
}
