use super::{Table, WorkspaceAccess, WorkspaceStore, access, file_storage::Directory};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields},
};
use axum::{
    Json,
    body::to_bytes,
    extract::{Path, Request, State as Extract},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{path::Path as FilePath, time::Duration};

async fn body(
    request: Request,
    state: &State,
    grant: &WorkspaceAccess,
    maximum: usize,
) -> Result<Vec<u8>> {
    let receive = to_bytes(request.into_body(), maximum);
    let timeout = tokio::time::sleep(Duration::from_secs(30));
    let mut check = tokio::time::interval(Duration::from_millis(200));
    tokio::pin!(receive, timeout);
    loop {
        tokio::select! {
            bytes = &mut receive => {
                grant.authorize(state).await?;
                return bytes.map(|v| v.to_vec()).map_err(|_| ApiError::new(413, "文件内容过大。"));
            }
            _ = &mut timeout => { return Err(ApiError::new(408, "文件上传超时，请重新上传。")); }
            _ = check.tick() => { grant.authorize(state).await?; }
        }
    }
}
fn mime(value: Option<&Value>) -> Result<String> {
    let Some(value) = value else {
        return Ok("application/octet-stream".into());
    };
    let text = value
        .as_str()
        .ok_or_else(|| ApiError::bad("文件类型无效。"))?;
    if text.is_empty() {
        return Ok("application/octet-stream".into());
    }
    if text.len() > 160
        || text.split('/').count() != 2
        || text.starts_with('/')
        || text.ends_with('/')
        || !text
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"!#$&^_.+-/".contains(&v))
    {
        return Err(ApiError::bad("文件类型无效。"));
    }
    Ok(text.to_owned())
}
pub async fn upload(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let bytes = body(request, &state, &grant, 15 * 1024 * 1024).await?;
    let input: Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("文件上传内容无效。"))?;
    only_fields(&input, &["name", "content", "type", "conversationId"])?;
    let name = input["name"]
        .as_str()
        .filter(|v| {
            !v.trim().is_empty()
                && v.encode_utf16().count() <= 160
                && !v.chars().any(char::is_control)
        })
        .ok_or_else(|| ApiError::bad("请提供有效的文件名（最多 160 个字符）。"))?;
    let content = input["content"]
        .as_str()
        .filter(|v| v.len() <= (10_usize * 1024 * 1024).div_ceil(3) * 4)
        .ok_or_else(|| ApiError::new(413, "文件最大为 10 MiB。"))?;
    let bytes = STANDARD
        .decode(content)
        .map_err(|_| ApiError::bad("文件内容不是有效的 Base64 数据。"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(ApiError::new(413, "文件最大为 10 MiB。"));
    }
    let file_type = mime(input.get("type"))?;
    let conversation = input
        .get("conversationId")
        .map(|v| {
            v.as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| ApiError::bad("会话标识无效。"))
        })
        .transpose()?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = store.begin().await?;
    grant.authorize(&state).await?;
    if let Some(cid) = conversation {
        WorkspaceStore::get_in(&mut tx, Table::Conversations, cid)
            .await?
            .ok_or_else(|| ApiError::new(404, "会话不存在。"))?;
    }
    let directory = Directory::open(&store.directory, true)?;
    let (name, uploaded) = directory.upload(name, &bytes, &id)?;
    let mut file =
        json!({"id":id,"name":name,"size":bytes.len(),"type":file_type,"createdAt":iso(now())});
    if let Some(cid) = conversation {
        file["conversationId"] = json!(cid);
    }
    WorkspaceStore::put_in(&mut tx, Table::Files, &file).await?;
    let message = if let Some(cid) = conversation {
        let message = json!({"id":uuid::Uuid::new_v4().to_string(),"conversationId":cid,"role":"user","kind":"file","userId":grant.user_id,"content":name,"createdAt":file["createdAt"],"metadata":{"fileId":id,"size":bytes.len(),"author":{"id":grant.user_id,"name":grant.user_name,"kind":"user"}}});
        WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        Some(message)
    } else {
        None
    };
    grant.authorize(&state).await?;
    tx.commit().await?;
    uploaded.commit();
    if let Some(message) = message {
        store.emit("message", message);
    }
    store.emit("update", json!({}));
    grant.authorize(&state).await?;
    Ok((StatusCode::CREATED, Json(file)))
}
pub async fn download(
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
    let store = grant.store(&state).await?;
    let file = store
        .get(Table::Files, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "文件不存在。"))?;
    let name = file["name"]
        .as_str()
        .ok_or_else(|| ApiError::new(409, "文件记录无效。"))?;
    let file_reader = Directory::open(&store.directory, false)?.reader(name)?;
    let length = file_reader.len();
    grant.authorize(&state).await?;
    let public_name = FilePath::new(name)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("download");
    let encoded: String = public_name
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let stream = futures_util::stream::try_unfold(
        (file_reader, state, grant, store),
        |(mut reader, state, grant, store)| async move {
            let fail = || {
                std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "File transfer interrupted",
                )
            };
            if store.is_closed() {
                return Err(fail());
            }
            grant.authorize(&state).await.map_err(|_| fail())?;
            let (reader, chunk) = tokio::task::spawn_blocking(move || {
                let result = reader.next();
                (reader, result)
            })
            .await
            .map_err(|_| fail())?;
            grant.authorize(&state).await.map_err(|_| fail())?;
            Ok(chunk
                .map_err(|_| fail())?
                .map(|bytes| (bytes, (reader, state, grant, store))))
        },
    );
    let mut response = axum::body::Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(
            &mime(file.get("type")).unwrap_or_else(|_| "application/octet-stream".into()),
        )
        .map_err(|_| ApiError::bad("文件类型无效。"))?,
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"download\"; filename*=UTF-8''{encoded}"
        ))
        .map_err(|_| ApiError::bad("文件名称无效。"))?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    Ok(response)
}
pub async fn remove(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let bytes = body(request, &state, &grant, 1024).await?;
    if !bytes.is_empty() && serde_json::from_slice::<Value>(&bytes).ok() != Some(json!({})) {
        return Err(ApiError::bad("删除文件不接受额外内容。"));
    }
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let file = WorkspaceStore::get_in(&mut tx, Table::Files, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "文件不存在。"))?;
    let name = file["name"]
        .as_str()
        .ok_or_else(|| ApiError::new(409, "文件记录无效。"))?;
    grant.authorize(&state).await?;
    let removed = match Directory::open(&store.directory, false)
        .and_then(|directory| directory.remove(name))
    {
        Ok(removed) => Some(removed),
        Err(error) if error.code == "FILE_NOT_FOUND" => None,
        Err(error) => return Err(error),
    };
    WorkspaceStore::delete_in(&mut tx, Table::Files, &id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    if let Some(removed) = removed {
        removed.commit()?;
    }
    store.emit("update", json!({}));
    grant.authorize(&state).await?;
    Ok(Json(json!({"ok":true})))
}
