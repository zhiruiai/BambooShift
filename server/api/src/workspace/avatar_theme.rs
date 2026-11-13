use super::{
    access,
    avatar_catalog::has_theme,
    creation_preview::{self, Kind},
};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

const MAX_REVISION: u64 = 9_007_199_254_740_991;
fn invalid() -> ApiError {
    ApiError::bad("头像主题设置无效，请重新选择主题。").with_code("AVATAR_THEME_INVALID")
}
fn normalize(theme: &Value) -> Result<Value> {
    if theme.is_null() {
        return Ok(Value::Null);
    }
    let fields = ["avatarTheme", "customAvatarTheme", "useCustomAvatarTheme"];
    only_fields(theme, &fields).map_err(|_| invalid())?;
    if !fields.iter().all(|field| theme.get(field).is_some()) {
        return Err(invalid());
    }
    let builtin = theme["avatarTheme"]
        .as_str()
        .filter(|id| has_theme(id))
        .ok_or_else(invalid)?;
    let enabled = theme["useCustomAvatarTheme"]
        .as_bool()
        .ok_or_else(invalid)?;
    let custom = if theme["customAvatarTheme"].is_null() {
        if enabled {
            return Err(invalid());
        }
        Value::Null
    } else {
        creation_preview::validate(Kind::Theme, &theme["customAvatarTheme"])
            .map_err(|_| invalid())?["theme"]
            .clone()
    };
    Ok(json!({"avatarTheme":builtin,"customAvatarTheme":custom,"useCustomAvatarTheme":enabled}))
}
async fn read(conn: &mut SqliteConnection, user: &str, workspace: &str) -> Result<Value> {
    let row = sqlx::query("SELECT theme_json,revision FROM account_workspace_avatar_themes WHERE user_id=? AND workspace_id=?")
        .bind(user).bind(workspace).fetch_optional(conn).await?;
    let Some(row) = row else {
        return Ok(json!({"theme":null,"revision":0}));
    };
    let unavailable =
        || ApiError::new(409, "保存的头像主题暂不可用。").with_code("AVATAR_THEME_UNAVAILABLE");
    let theme: Value = serde_json::from_str(row.get("theme_json")).map_err(|_| unavailable())?;
    let revision: i64 = row.get("revision");
    if revision < 1 || revision as u64 > MAX_REVISION {
        return Err(unavailable());
    }
    Ok(json!({"theme":normalize(&theme).map_err(|_| unavailable())?,"revision":revision}))
}
pub(super) async fn get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let mut tx = state.pool.begin().await?;
    grant.authorize_in(&mut tx).await?;
    let value = read(&mut tx, &grant.user_id, &wid).await?;
    tx.commit().await?;
    grant.authorize(&state).await?;
    Ok(Json(value))
}
pub(super) async fn put(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    only_fields(&body, &["theme", "revision"]).map_err(|_| invalid())?;
    let theme = normalize(body.get("theme").ok_or_else(invalid)?)?;
    let revision = body["revision"]
        .as_u64()
        .filter(|n| *n < MAX_REVISION)
        .ok_or_else(invalid)?;
    // The write and current membership check share one identity-database transaction.
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    grant.authorize_in(&mut tx).await?;
    let current = read(&mut tx, &grant.user_id, &wid).await?;
    if current["revision"] != revision {
        return Err(
            ApiError::new(409, "头像主题已在其他设备更新，请读取最新设置后重试。")
                .with_code("AVATAR_THEME_CONFLICT"),
        );
    }
    let next = revision + 1;
    sqlx::query("INSERT INTO account_workspace_avatar_themes(user_id,workspace_id,theme_json,revision) VALUES(?,?,?,?) ON CONFLICT(user_id,workspace_id) DO UPDATE SET theme_json=excluded.theme_json,revision=excluded.revision")
        .bind(&grant.user_id).bind(&wid).bind(theme.to_string()).bind(next as i64).execute(&mut *tx).await?;
    grant.authorize_in(&mut tx).await?;
    tx.commit().await?;
    grant.authorize(&state).await?;
    Ok(Json(json!({"theme":theme,"revision":next})))
}
