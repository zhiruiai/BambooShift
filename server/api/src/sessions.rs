use crate::{
    db::{State, now},
    error::{ApiError, Result},
    models::{Identity, User, Workspace},
    password,
};
use axum::http::{HeaderMap, header};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

pub(crate) fn cookie_token(state: &State, headers: &HeaderMap, purpose: &str) -> Option<String> {
    let prefix = format!("{}=", state.config.cookie_name(purpose));
    let mut found = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|h| h.split(';'))
        .map(str::trim)
        .filter_map(|s| s.strip_prefix(&prefix));
    let token = found.next()?;
    if found.next().is_some() || !password::valid_token(token) {
        return None;
    }
    Some(token.to_owned())
}
pub(crate) async fn read(
    conn: &mut SqliteConnection,
    state: &State,
    headers: &HeaderMap,
    purpose: &str,
) -> Result<Option<Identity>> {
    let Some(token) = cookie_token(state, headers, purpose) else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT u.*,s.id AS session_id FROM account_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.purpose=? AND s.expires_at>? AND u.status='active'")
        .bind(password::digest(&token)).bind(purpose).bind(now()).fetch_optional(&mut *conn).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let user = <User as sqlx::FromRow<_>>::from_row(&row)?;
    if purpose == "operator" && user.platform_role != "admin" {
        return Ok(None);
    }
    Ok(Some(Identity {
        user,
        session_id: row.try_get("session_id")?,
    }))
}
pub(crate) async fn require(
    conn: &mut SqliteConnection,
    state: &State,
    headers: &HeaderMap,
    purpose: &str,
) -> Result<Identity> {
    let identity = read(conn, state, headers, purpose).await?.ok_or_else(|| {
        ApiError::new(
            401,
            if purpose == "operator" {
                "请登录平台运营后台。"
            } else {
                "请先登录你的账户。"
            },
        )
    })?;
    if let Some(expected) = headers.get("x-openbot-expected-user") {
        if expected.to_str().ok() != Some(identity.user.id.as_str()) {
            return Err(ApiError::new(403, "账户已变化，请刷新后重试。"));
        }
    }
    Ok(identity)
}
pub(crate) async fn issue(
    conn: &mut SqliteConnection,
    state: &State,
    headers: &HeaderMap,
    user: &User,
    purpose: &str,
) -> Result<String> {
    if let Some(old) = read(conn, state, headers, purpose).await? {
        sqlx::query("DELETE FROM account_sessions WHERE id=?")
            .bind(old.session_id)
            .execute(&mut *conn)
            .await?;
    }
    let raw = password::token();
    let started = now();
    let ttl = if purpose == "operator" {
        43_200_000
    } else {
        2_592_000_000
    };
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let name = if ua.contains("OpenBotDesktop") {
        "PandaMate 桌面客户端"
    } else if ["Mobile", "Android", "iPhone"]
        .iter()
        .any(|s| ua.contains(s))
    {
        "手机浏览器"
    } else {
        "网页浏览器"
    };
    sqlx::query("INSERT INTO account_sessions VALUES(?,?,?,?,?,?,?)")
        .bind(Uuid::new_v4().to_string())
        .bind(password::digest(&raw))
        .bind(&user.id)
        .bind(purpose)
        .bind(name)
        .bind(started)
        .bind(started + ttl)
        .execute(conn)
        .await?;
    Ok(state.config.cookie(purpose, &raw))
}
pub(crate) async fn account_state(conn: &mut SqliteConnection, user: &User) -> Result<Value> {
    let workspaces = sqlx::query_as::<_, Workspace>("SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY m.joined_at,w.rowid")
        .bind(&user.id).fetch_all(conn).await?;
    Ok(
        json!({"authenticated":true,"user":user.public(),"workspaces":workspaces.iter().map(Workspace::public).collect::<Vec<_>>()}),
    )
}
pub(crate) fn expected_body(body: &Value, identity: &Identity) -> Result<()> {
    if body["expectedUserId"].as_str() != Some(identity.user.id.as_str()) {
        return Err(ApiError::new(409, "账户已变化，请刷新后重试。"));
    }
    Ok(())
}
