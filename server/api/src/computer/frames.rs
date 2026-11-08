use super::{
    controls, model,
    transport::{Authority, Request, Target},
};
use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;

pub async fn save(
    store: &WorkspaceStore,
    target: &Arc<Target>,
    frame: &Value,
    conversation: &str,
    agent: &str,
    authorize: Authority,
) -> Result<Value> {
    let data = frame["data"]
        .as_str()
        .filter(|s| s.len() <= model::MAX_FILE.div_ceil(3) * 4)
        .ok_or_else(|| ApiError::bad("操作画面无效。"))?;
    let created = frame["capturedAt"]
        .as_str()
        .filter(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok())
        .ok_or_else(|| ApiError::bad("操作画面时间无效。"))?
        .to_owned();
    if frame["mimeType"] != "image/png" {
        return Err(ApiError::bad("操作画面格式无效。"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| ApiError::bad("操作画面无效。"))?;
    if bytes.len() > model::MAX_FILE {
        return Err(ApiError::new(413, "操作画面过大。"));
    }
    controls::png_dimensions(&bytes)?;
    authorize().await?;
    let encoded = tokio::task::spawn_blocking(move || encode(&bytes))
        .await
        .map_err(|_| ApiError::new(500, "操作画面未能保存。"))??;
    authorize().await?;
    let takeover = target
        .request(Request::get("/takeover/status"), authorize.clone())
        .await?
        .json()?;
    if takeover["active"] != false {
        return Err(ApiError::new(409, "用户已接管，操作画面不会保存。"));
    }
    let mut tx = store.begin().await?;
    WorkspaceStore::get_in(&mut tx, Table::Conversations, conversation)
        .await?
        .ok_or_else(|| ApiError::new(404, "操作所属会话已不可用。"))?;
    WorkspaceStore::get_in(&mut tx, Table::Agents, agent)
        .await?
        .ok_or_else(|| ApiError::new(404, "操作所属 Bot 已不可用。"))?;
    target.active()?;
    authorize().await?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO computer_frames(id,conversation_id,agent_id,created_at,width,height,mime_type,bytes) VALUES(?,?,?,?,?,?,?,?)")
        .bind(&id).bind(conversation).bind(agent).bind(&created).bind(encoded.1).bind(encoded.2).bind("image/webp").bind(encoded.0).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM computer_frames WHERE id IN (SELECT id FROM computer_frames ORDER BY rowid DESC LIMIT -1 OFFSET 200)").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(
        json!({"id":id,"createdAt":created,"width":encoded.1,"height":encoded.2,"mimeType":"image/webp"}),
    )
}
fn encode(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(192 * 1024 * 1024);
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| ApiError::bad("操作画面不是有效截图。"))?;
    let image = if image.width() > 1400 || image.height() > 1400 {
        image.resize(1400, 1400, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let rgba = image.to_rgba8();
    let encoded = webp::Encoder::from_rgba(&rgba, image.width(), image.height())
        .encode(72.0)
        .to_vec();
    if encoded.len() > 1024 * 1024 {
        return Err(ApiError::new(413, "操作画面过大。"));
    }
    Ok((encoded, image.width(), image.height()))
}
pub async fn read(store: &WorkspaceStore, id: &str) -> Result<Vec<u8>> {
    if !model::uuid(id) {
        return Err(ApiError::new(404, "操作画面已不可用。"));
    }
    let row = sqlx::query("SELECT conversation_id,bytes FROM computer_frames WHERE id=?")
        .bind(id)
        .fetch_optional(&store.pool)
        .await?
        .ok_or_else(|| ApiError::new(404, "操作画面已过期或已删除。"))?;
    if store
        .get(
            Table::Conversations,
            &row.get::<String, _>("conversation_id"),
        )
        .await?
        .is_none()
    {
        return Err(ApiError::new(404, "操作所属会话已删除。"));
    }
    Ok(row.get("bytes"))
}
