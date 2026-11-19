use super::{
    Asset, MAX_FILE_BYTES, Manifest, asset_type, attachment, changed, digest, find, missing,
    portable_path,
};
use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(super) async fn capture_paths(
    conn: &mut SqliteConnection,
    request: &super::Publication,
    conversation_id: &str,
    has_delivery: bool,
) -> Result<Vec<(String, String, String)>> {
    let mut specs = Vec::with_capacity(request.files.len());
    for file in &request.files {
        let source = if let Some(attachment) = &file.attachment_id {
            let record = WorkspaceStore::get_in(conn, Table::Files, attachment)
                .await?
                .filter(|row| row["conversationId"] == conversation_id)
                .ok_or_else(missing)?;
            let name = record["name"]
                .as_str()
                .filter(|name| !name.contains(['/', '\\']))
                .ok_or_else(missing)?;
            if asset_type(name) != asset_type(&file.path) {
                return Err(super::invalid());
            }
            name.to_owned()
        } else {
            if has_delivery {
                continue;
            }
            let path = format!("{}/{}", request.directory, file.path);
            let registered: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM files WHERE json_extract(data,'$.name')=? LIMIT 1",
            )
            .bind(&path)
            .fetch_optional(&mut *conn)
            .await?;
            if registered.is_none() {
                return Err(ApiError::new(404, format!("文件 {} 尚未登记。请用 workspace_write 保存工作文件，或使用本会话上传文件的 attachmentId。", file.path)).with_code("WEBSITE_PROJECT_FILE_UNREGISTERED"));
            }
            path
        };
        specs.push((file.path.clone(), source, file.sha256.clone()));
    }
    Ok(specs)
}

const TEXT_PAGE_BYTES: usize = 32 * 1024;

fn asset<'a>(manifest: &'a Manifest, path: &str) -> Result<&'a Asset> {
    if !portable_path(path) {
        return Err(missing());
    }
    manifest
        .files
        .iter()
        .find(|asset| asset.path == path)
        .ok_or_else(missing)
}

async fn bytes(conn: &mut SqliteConnection, id: &str, asset: &Asset) -> Result<Vec<u8>> {
    let bytes: Vec<u8> =
        sqlx::query_scalar("SELECT bytes FROM website_project_files WHERE project_id=? AND path=?")
            .bind(id)
            .bind(&asset.path)
            .fetch_optional(conn)
            .await?
            .ok_or_else(missing)?;
    if bytes.len() != asset.size || bytes.len() > MAX_FILE_BYTES || digest(&bytes) != asset.sha256 {
        return Err(changed());
    }
    Ok(bytes)
}

pub(in crate::workspace) async fn asset_response(
    conn: &mut SqliteConnection,
    id: &str,
    path: &str,
) -> Result<Response> {
    let manifest = find(conn, id).await?.ok_or_else(missing)?;
    let bytes = bytes(conn, id, asset(&manifest, path)?).await?;
    attachment(
        bytes,
        "application/octet-stream",
        path.rsplit('/').next().unwrap_or("asset"),
    )
}

pub(crate) async fn quoted_source(
    conn: &mut SqliteConnection,
    id: &str,
    project_key: &str,
    path: Option<&str>,
    offset: usize,
) -> Result<(Value, Option<String>)> {
    let manifest = find(conn, id)
        .await?
        .filter(|value| value.summary.project_key == project_key)
        .ok_or_else(missing)?;
    let Some(path) = path else {
        return Ok((json!(manifest), None));
    };
    let file = asset(&manifest, path)?;
    let (mime, is_text) = asset_type(path).ok_or_else(changed)?;
    if mime != file.mime {
        return Err(changed());
    }
    let mut info = json!({"versionId":id,"file":file,"textAvailable":is_text});
    if !is_text {
        if offset != 0 {
            return Err(invalid_offset());
        }
        return Ok((info, None));
    }
    let bytes = bytes(conn, id, file).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| changed())?;
    let (page, next) = text_page(text, offset)?;
    info["offset"] = json!(offset);
    info["nextOffset"] = json!(next);
    Ok((info, Some(page.to_owned())))
}

fn invalid_offset() -> ApiError {
    ApiError::bad("请使用版本源码返回的有效字节偏移量。").with_code("WEBSITE_SOURCE_OFFSET_INVALID")
}

fn text_page(text: &str, offset: usize) -> Result<(&str, Option<usize>)> {
    if !text.is_char_boundary(offset) {
        return Err(invalid_offset());
    }
    let mut end = offset.saturating_add(TEXT_PAGE_BYTES).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((&text[offset..end], (end < text.len()).then_some(end)))
}

#[cfg(test)]
#[path = "../../../tests/unit/workspace/website_projects/source.rs"]
mod tests;
