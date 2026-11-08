use super::access;
use crate::{
    db::{State, now},
    error::{ApiError, Result},
};
use axum::{
    body::to_bytes,
    extract::{Path, Request, State as Extract},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use sqlx::{Row, SqliteConnection};

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS avatar_assets(id TEXT PRIMARY KEY,data TEXT NOT NULL,bytes BLOB NOT NULL,published INTEGER NOT NULL DEFAULT 0 CHECK(published IN(0,1)))").execute(&mut *conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS avatar_sources(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,data TEXT NOT NULL,original BLOB NOT NULL,preview BLOB NOT NULL)").execute(conn).await?;
    Ok(())
}
fn valid(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_| ApiError::bad("头像标识无效。"))?;
    Ok(())
}
pub async fn publish(conn: &mut SqliteConnection, value: &Value) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    let id = value
        .as_str()
        .ok_or_else(|| ApiError::bad("头像标识无效。"))?;
    valid(id)?;
    let affected = sqlx::query("UPDATE avatar_assets SET published=1 WHERE id=?")
        .bind(id)
        .execute(conn)
        .await?
        .rows_affected();
    if affected != 1 {
        return Err(ApiError::new(409, "头像不存在或不属于当前空间。"));
    }
    Ok(())
}
fn image(bytes: Vec<u8>, maximum: usize) -> Result<Response> {
    if bytes.len() > maximum
        || bytes.len() < 12
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WEBP"
    {
        return Err(ApiError::new(409, "头像资产不可用。"));
    }
    Ok((
        [
            (header::CONTENT_TYPE, "image/webp"),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::HeaderName::from_static("cross-origin-resource-policy"),
                "same-origin",
            ),
        ],
        bytes,
    )
        .into_response())
}
pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let grant = access::require(
        &state,
        &headers,
        &wid,
        false,
        headers.contains_key("x-openbot-expected-user"),
    )
    .await?;
    valid(&id)?;
    let store = grant.store(&state).await?;
    let row = sqlx::query("SELECT bytes,published FROM avatar_assets WHERE id=?")
        .bind(id)
        .fetch_optional(&store.pool)
        .await?
        .ok_or_else(|| ApiError::new(404, "头像不存在。"))?;
    if row.get::<i64, _>("published") != 1 {
        grant.authorize_owner(&state).await?;
    }
    grant.authorize(&state).await?;
    image(row.get("bytes"), 512 * 1024)
}
pub async fn source(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    valid(&id)?;
    let store = grant.store(&state).await?;
    let row = sqlx::query("SELECT preview FROM avatar_sources WHERE id=? AND expires_at>?")
        .bind(id)
        .bind(now())
        .fetch_optional(&store.pool)
        .await?
        .ok_or_else(|| ApiError::new(404, "头像原图已过期或不存在。"))?;
    grant.authorize(&state).await?;
    image(row.get("preview"), 2 * 1024 * 1024)
}
pub async fn drop_source(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    request: Request,
) -> Result<StatusCode> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    valid(&id)?;
    let bytes = to_bytes(request.into_body(), 1024)
        .await
        .map_err(|_| ApiError::bad("删除头像原图不接受额外内容。"))?;
    if !bytes.is_empty()
        && serde_json::from_slice::<Value>(&bytes).ok() != Some(serde_json::json!({}))
    {
        return Err(ApiError::bad("删除头像原图不接受额外内容。"));
    }
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    sqlx::query("DELETE FROM avatar_sources WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    grant.authorize(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}
