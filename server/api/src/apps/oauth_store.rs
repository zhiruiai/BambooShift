use super::{credentials, store};
use crate::{
    db::{State, now},
    error::{ApiError, Result},
    workspace::{WorkspaceAccess, WorkspaceStore},
};
use base64::Engine;
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const CALLBACK: &str = "/api/app-oauth/callback";
pub const RESULT: &str = "/api/app-oauth/result";
pub fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub fn expired(flow: &Value) -> bool {
    flow["expiresAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_none_or(|d| d.timestamp_millis() <= now())
}
pub fn terminal(flow: &Value) -> bool {
    ["complete", "cancelled", "expired", "error"].contains(&flow["status"].as_str().unwrap_or(""))
}
pub fn origin(state: &State) -> String {
    state
        .config
        .public_origin
        .clone()
        .unwrap_or_else(|| format!("http://{}", state.config.bind))
}
pub fn cookie_name(state: &State, id: &str) -> String {
    format!(
        "{}openbot_oauth_{}",
        if state.config.public_origin.is_some() {
            "__Secure-"
        } else {
            ""
        },
        id.replace('-', "")
    )
}
pub fn cookie(state: &State, id: &str, value: &str, age: i64) -> String {
    format!(
        "{}={value}; Path={CALLBACK}; HttpOnly; SameSite=Lax; Max-Age={age}{}",
        cookie_name(state, id),
        if state.config.public_origin.is_some() {
            "; Secure"
        } else {
            ""
        }
    )
}
pub async fn save(store: &WorkspaceStore, record: &Value) -> Result<()> {
    store::put_raw(store, "app_oauth_flows", record).await
}
pub async fn end(
    store: &WorkspaceStore,
    record: &mut Value,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let old = record["privateRef"].as_str().map(str::to_owned);
    record["flow"]["status"] = json!(status);
    if let Some(error) = error {
        record["flow"]["error"] = json!(error);
    }
    record["flow"].as_object_mut().unwrap().remove("launchPath");
    for field in ["privateRef", "stateHash", "cookieHash", "browserSessionId"] {
        record.as_object_mut().unwrap().remove(field);
    }
    save(store, record).await?;
    credentials::remove(store, old.as_deref()).await
}
pub async fn valid(
    state: &State,
    store: &WorkspaceStore,
    record: &Value,
    browser: bool,
) -> Result<()> {
    state.apps.active()?;
    if terminal(&record["flow"])
        || record["flow"]["expiresAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_none_or(|d| d.timestamp_millis() <= now())
    {
        return Err(ApiError::new(409, "授权流程已结束或过期。"));
    }
    for key in if browser {
        vec!["initiatorSessionId", "browserSessionId"]
    } else {
        vec!["initiatorSessionId"]
    } {
        let session = record[key]
            .as_str()
            .ok_or_else(|| ApiError::new(409, "授权会话已失效。"))?;
        let allowed:Option<i64>=sqlx::query_scalar("SELECT 1 FROM account_sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE s.id=? AND s.user_id=? AND s.purpose='account' AND s.expires_at>? AND u.status='active' AND m.role='owner' AND w.id=? AND w.status='active' AND w.storage_key=?")
            .bind(session).bind(record["ownerId"].as_str()).bind(now()).bind(&store.workspace_id).bind(record["storageKey"].as_str()).fetch_optional(&state.pool).await?;
        if allowed.is_none() {
            return Err(ApiError::new(403, "账号或工作空间权限已失效。"));
        }
    }
    let connection =
        store::connection(store, record["flow"]["connectionId"].as_str().unwrap_or("")).await?;
    if connection.auth_type != "oauth"
        || connection.revision != record["flow"]["connectionRevision"]
    {
        return Err(ApiError::new(409, "应用连接已更改，请重新开始授权。"));
    }
    Ok(())
}
pub async fn view(
    state: &State,
    store: &WorkspaceStore,
    actor: &WorkspaceAccess,
    cid: &str,
    fid: &str,
    other_browser: bool,
) -> Result<Value> {
    // Reject missing records before allocating a lock for a supplied ID.
    store::get_raw(store, "app_oauth_flows", fid).await?;
    let lock = state.apps.lock(&format!("oauth:{fid}")).await;
    let _guard = lock.lock().await;
    Ok(authorize(state, store, actor, cid, fid, other_browser).await?["flow"].clone())
}
pub async fn authorize(
    state: &State,
    store: &WorkspaceStore,
    actor: &WorkspaceAccess,
    cid: &str,
    fid: &str,
    other_browser: bool,
) -> Result<Value> {
    actor.authorize_owner(state).await?;
    let mut record = store::get_raw(store, "app_oauth_flows", fid).await?;
    if record["ownerId"] != actor.user_id
        || record["flow"]["connectionId"] != cid
        || (!other_browser && record["initiatorSessionId"] != actor.session_id)
    {
        return Err(ApiError::new(404, "此授权流程不属于当前登录会话。"));
    }
    if !terminal(&record["flow"])
        && valid(
            state,
            store,
            &record,
            record.get("browserSessionId").is_some(),
        )
        .await
        .is_err()
    {
        let status = if expired(&record["flow"]) {
            "expired"
        } else {
            "cancelled"
        };
        end(
            store,
            &mut record,
            status,
            Some("账号、空间或应用连接已变化，或授权已过期，请重新开始授权。"),
        )
        .await?;
    }
    Ok(record)
}
