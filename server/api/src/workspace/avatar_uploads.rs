use super::{WorkspaceAccess, WorkspaceStore, access, avatar_jobs};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields},
};
use axum::{
    Json,
    body::to_bytes,
    extract::{Path, Request, State as Extract},
    http::{HeaderMap, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;
const UPLOAD_BYTES: usize = 25 * 1024 * 1024;

pub async fn stage(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let mime = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
        return Err(ApiError::bad("请上传 PNG、JPEG 或 WebP 图片。"));
    }
    if headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n >= UPLOAD_BYTES)
    {
        return Err(ApiError::new(413, "头像图片必须小于 25 MiB。"));
    }
    let store = grant.store(&state).await?;
    let lease = avatar_jobs::active(&store).await?;
    let value = lease.run(move |job| async move {
        let bytes = job.guard(&state, &grant, 30, async {
            to_bytes(request.into_body(), UPLOAD_BYTES).await.map(|b| b.to_vec()).map_err(|_| ApiError::new(413, "头像图片必须小于 25 MiB。"))
        }).await?;
        if bytes.is_empty() || bytes.len() >= UPLOAD_BYTES { return Err(ApiError::new(413, "头像图片必须小于 25 MiB。")); }
        let output = avatar_jobs::process(&job, &state, &grant, json!({"op":"source","bytes":STANDARD.encode(&bytes),"crop":null})).await?;
        let preview = output_bytes(&output, 2 * 1024 * 1024)?;
        let expires = now() + 3_600_000;
        let source = json!({"id":uuid::Uuid::new_v4().to_string(),"width":output["width"],"height":output["height"],"previewWidth":output["previewWidth"],"previewHeight":output["previewHeight"],"expiresAt":iso(expires)});
        let mut tx = store.begin().await?;
        job.authorize(&state, &grant).await?;
        sqlx::query("DELETE FROM avatar_sources WHERE expires_at<=?").bind(now()).execute(&mut *tx).await?;
        let row = sqlx::query("SELECT count(*) AS count,coalesce(sum(length(original)+length(preview)),0) AS size FROM avatar_sources").fetch_one(&mut *tx).await?;
        if row.get::<i64,_>("count") >= 8 || row.get::<i64,_>("size") + (bytes.len() + preview.len()) as i64 > 96 * 1024 * 1024 {
            return Err(ApiError::new(409, "当前空间暂存头像已满，请删除不用的原图或等待过期。"));
        }
        sqlx::query("INSERT INTO avatar_sources(id,expires_at,data,original,preview) VALUES(?,?,?,?,?)")
            .bind(source["id"].as_str().unwrap()).bind(expires).bind(source.to_string()).bind(bytes).bind(preview).execute(&mut *tx).await?;
        job.authorize(&state, &grant).await?;
        tx.commit().await?;
        job.authorize(&state, &grant).await?;
        Ok(source)
    }).await?;
    Ok((StatusCode::CREATED, Json(value)))
}

pub async fn crop(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let lease = avatar_jobs::active(&store).await?;
    let value = lease.run(move |job| async move {
        let bytes = job.guard(&state, &grant, 30, async { to_bytes(request.into_body(), 2048).await.map_err(|_| ApiError::new(413, "头像裁剪参数过大。")) }).await?;
        let input: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("头像裁剪参数无效。"))?;
        only_fields(&input, &["sourceId", "crop"])?;
        only_fields(&input["crop"], &["left", "top", "size"])?;
        let id = input["sourceId"].as_str().filter(|s| uuid::Uuid::parse_str(s).is_ok()).ok_or_else(|| ApiError::bad("头像原图标识无效。"))?;
        for field in ["left", "top", "size"] {
            if !input["crop"][field].as_u64().is_some_and(|n| n <= u32::MAX as u64 && (field != "size" || n > 0)) { return Err(ApiError::bad("裁剪区域需要使用有效的整数像素。")); }
        }
        let original: Vec<u8> = sqlx::query_scalar("SELECT original FROM avatar_sources WHERE id=? AND expires_at>?")
            .bind(id).bind(now()).fetch_optional(&store.pool).await?.ok_or_else(|| ApiError::new(404, "原图已过期或不属于当前空间，请重新上传。"))?;
        let output = avatar_jobs::process(&job, &state, &grant, json!({"op":"crop","bytes":STANDARD.encode(original),"crop":input["crop"]})).await?;
        let bytes = output_bytes(&output, 512 * 1024)?;
        let asset = json!({"id":uuid::Uuid::new_v4().to_string(),"width":512,"height":512,"mimeType":"image/webp","createdAt":iso(now())});
        save_asset(&store, &state, &grant, &job, id, &asset, bytes).await?;
        Ok(asset)
    }).await?;
    Ok((StatusCode::CREATED, Json(value)))
}
async fn save_asset(
    store: &Arc<WorkspaceStore>,
    state: &State,
    grant: &WorkspaceAccess,
    job: &avatar_jobs::Cancellation,
    source_id: &str,
    asset: &Value,
    bytes: Vec<u8>,
) -> Result<()> {
    let mut tx = store.begin().await?;
    job.authorize(state, grant).await?;
    let exists: i64 =
        sqlx::query_scalar("SELECT count(*) FROM avatar_sources WHERE id=? AND expires_at>?")
            .bind(source_id)
            .bind(now())
            .fetch_one(&mut *tx)
            .await?;
    if exists != 1 {
        return Err(ApiError::new(404, "原图已过期或已删除，请重新上传。"));
    }
    let row = sqlx::query(
        "SELECT count(*) AS count,coalesce(sum(length(bytes)),0) AS size FROM avatar_assets",
    )
    .fetch_one(&mut *tx)
    .await?;
    if row.get::<i64, _>("count") >= 512
        || row.get::<i64, _>("size") + bytes.len() as i64 > 64 * 1024 * 1024
    {
        return Err(ApiError::new(
            409,
            "当前空间头像存储已达上限，已有头像仍然保留。",
        ));
    }
    sqlx::query("INSERT INTO avatar_assets(id,data,bytes,published) VALUES(?,?,?,0)")
        .bind(asset["id"].as_str().unwrap())
        .bind(asset.to_string())
        .bind(bytes)
        .execute(&mut *tx)
        .await?;
    job.authorize(state, grant).await?;
    tx.commit().await?;
    job.authorize(state, grant).await
}
fn output_bytes(output: &Value, maximum: usize) -> Result<Vec<u8>> {
    let encoded = output["bytes"]
        .as_str()
        .ok_or_else(|| ApiError::new(503, "头像处理结果无效。"))?;
    if encoded.len() > maximum.div_ceil(3) * 4 {
        return Err(ApiError::new(413, "头像处理结果过大。"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::new(503, "头像处理结果无效。"))?;
    if bytes.len() > maximum
        || bytes.len() < 12
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WEBP"
    {
        return Err(ApiError::new(503, "头像处理结果无效。"));
    }
    Ok(bytes)
}
