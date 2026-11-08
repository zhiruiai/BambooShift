use super::{WorkspaceStore, access, file_storage::Directory};
use crate::{
    db::State,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::HashSet;

pub(crate) const MAX_FILES: usize = 64;
pub(crate) const MAX_PATH: usize = 240;
pub(crate) const MAX_TITLE: usize = 100;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROJECT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Publication {
    pub directory: String,
    title: String,
    entry: String,
    files: Vec<SourceFile>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceFile {
    path: String,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub id: String,
    pub(super) project_key: String,
    title: String,
    entry: String,
    file_count: usize,
    total_bytes: usize,
}

#[derive(Deserialize, Serialize)]
struct Asset {
    path: String,
    mime: String,
    size: usize,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    #[serde(flatten)]
    summary: Summary,
    files: Vec<Asset>,
}

fn invalid() -> ApiError {
    ApiError::bad("网站项目清单无效。").with_code("WEBSITE_PROJECT_INVALID")
}

fn missing() -> ApiError {
    ApiError::new(404, "网站项目或文件不存在。").with_code("WEBSITE_PROJECT_NOT_FOUND")
}

fn changed() -> ApiError {
    ApiError::new(409, "网站项目的源文件已变化，请重新读取后再交付。")
        .with_code("WEBSITE_PROJECT_CHANGED")
}

fn portable_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH
        && path.split('/').count() <= 12
        && path.split('/').all(|part| {
            if part.is_empty()
                || part.len() > 80
                || part.starts_with('.')
                || part.ends_with('.')
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            {
                return false;
            }
            let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
            !["con", "prn", "aux", "nul", "node_modules"].contains(&stem.as_str())
                && !(stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && (b'1'..=b'9').contains(&stem.as_bytes()[3]))
        })
}

fn asset_type(path: &str) -> Option<(&'static str, bool)> {
    Some(
        match path.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
            "html" | "htm" => ("text/html", true),
            "css" => ("text/css", true),
            "js" | "mjs" => ("text/javascript", true),
            "json" | "webmanifest" => ("application/json", true),
            "svg" => ("image/svg+xml", true),
            "txt" | "md" => ("text/plain", true),
            "csv" => ("text/csv", true),
            "png" => ("image/png", false),
            "jpeg" | "jpg" => ("image/jpeg", false),
            "gif" => ("image/gif", false),
            "webp" => ("image/webp", false),
            "avif" => ("image/avif", false),
            "ico" => ("image/x-icon", false),
            "woff" => ("font/woff", false),
            "woff2" => ("font/woff2", false),
            _ => return None,
        },
    )
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

impl Publication {
    pub(crate) fn parse(args: &Value) -> Result<Self> {
        if !args["files"]
            .as_array()
            .is_some_and(|files| (1..=MAX_FILES).contains(&files.len()))
        {
            return Err(invalid());
        }
        let mut input = Self::deserialize(args).map_err(|_| invalid())?;
        input.title = input.title.trim().to_owned();
        if input.title.is_empty()
            || input.title.encode_utf16().count() > MAX_TITLE
            || input.title.chars().any(char::is_control)
            || !portable_path(&input.directory)
            || asset_type(&input.entry) != Some(("text/html", true))
        {
            return Err(invalid());
        }
        let mut names = HashSet::new();
        for file in &mut input.files {
            if !portable_path(&file.path)
                || asset_type(&file.path).is_none()
                || !names.insert(file.path.to_ascii_lowercase())
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(invalid());
            }
            file.sha256.make_ascii_lowercase();
        }
        if !input.files.iter().any(|file| file.path == input.entry) {
            return Err(invalid());
        }
        input.files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        Ok(input)
    }

    fn identity(&self, workspace: &str, storage_key: &str) -> (String, String) {
        let project_key = digest(
            json!([1, workspace, storage_key, self.directory])
                .to_string()
                .as_bytes(),
        );
        let id = digest(
            json!([1, project_key, self.title, self.entry, self.files])
                .to_string()
                .as_bytes(),
        );
        (id, project_key)
    }
}

pub(crate) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS website_projects(id TEXT PRIMARY KEY,manifest TEXT NOT NULL)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS website_project_files(project_id TEXT NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,path TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(project_id,path))")
        .execute(&mut *conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS website_project_publishers(project_key TEXT PRIMARY KEY,user_id TEXT NOT NULL)")
        .execute(conn).await?;
    Ok(())
}

async fn find(conn: &mut SqliteConnection, id: &str) -> Result<Option<Manifest>> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(missing());
    }
    let manifest: Option<String> =
        sqlx::query_scalar("SELECT manifest FROM website_projects WHERE id=?")
            .bind(id)
            .fetch_optional(conn)
            .await?;
    manifest
        .map(|raw| {
            let parsed: Manifest = serde_json::from_str(&raw).map_err(|_| changed())?;
            if parsed.summary.id != id
                || parsed.files.len() != parsed.summary.file_count
                || parsed.files.len() > MAX_FILES
                || parsed.summary.total_bytes > MAX_PROJECT_BYTES
            {
                return Err(changed());
            }
            Ok(parsed)
        })
        .transpose()
}

pub(crate) async fn snapshot(
    conn: &mut SqliteConnection,
    store: &WorkspaceStore,
    storage_key: &str,
    publisher_id: &str,
    request: &Publication,
) -> Result<Summary> {
    let (id, project_key) = request.identity(&store.workspace_id, storage_key);
    if let Some(saved) = find(conn, &id).await? {
        return Ok(saved.summary);
    }
    for file in &request.files {
        let path = format!("{}/{}", request.directory, file.path);
        let registered: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM files WHERE json_extract(data,'$.name')=? LIMIT 1")
                .bind(path)
                .fetch_optional(&mut *conn)
                .await?;
        if registered.is_none() {
            return Err(missing());
        }
    }
    let directory = store.directory.clone();
    let project_path = request.directory.clone();
    let specs = request
        .files
        .iter()
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect();
    let captured = tokio::task::spawn_blocking(move || capture(&directory, &project_path, specs))
        .await
        .map_err(|_| changed())??;
    let mut manifest = Manifest {
        summary: Summary {
            id,
            project_key,
            title: request.title.clone(),
            entry: request.entry.clone(),
            file_count: captured.len(),
            total_bytes: captured.iter().map(|(_, bytes)| bytes.len()).sum(),
        },
        files: Vec::with_capacity(captured.len()),
    };
    let (assets, bytes): (Vec<_>, Vec<_>) = captured.into_iter().unzip();
    manifest.files = assets;
    sqlx::query(
        "INSERT OR IGNORE INTO website_project_publishers(project_key,user_id)
         SELECT ?,? WHERE NOT EXISTS (
             SELECT 1 FROM website_projects WHERE json_extract(manifest,'$.projectKey')=?
         )",
    )
    .bind(&manifest.summary.project_key)
    .bind(publisher_id)
    .bind(&manifest.summary.project_key)
    .execute(&mut *conn)
    .await?;
    sqlx::query("INSERT INTO website_projects(id,manifest) VALUES(?,?)")
        .bind(&manifest.summary.id)
        .bind(serde_json::to_string(&manifest).map_err(|_| invalid())?)
        .execute(&mut *conn)
        .await?;
    for (asset, bytes) in manifest.files.iter().zip(bytes) {
        sqlx::query("INSERT INTO website_project_files(project_id,path,bytes) VALUES(?,?,?)")
            .bind(&manifest.summary.id)
            .bind(&asset.path)
            .bind(bytes)
            .execute(&mut *conn)
            .await?;
    }
    Ok(manifest.summary)
}

fn capture(
    directory: &std::path::Path,
    project_path: &str,
    specs: Vec<(String, String)>,
) -> Result<Vec<(Asset, Vec<u8>)>> {
    let directory = Directory::open(directory, false)?;
    let mut captured = Vec::with_capacity(specs.len());
    let mut total = 0;
    for (path, sha256) in specs {
        let mut reader = directory.reader(&format!("{project_path}/{path}"))?;
        let length = reader.len();
        if length > MAX_FILE_BYTES as u64 || total + length > MAX_PROJECT_BYTES as u64 {
            return Err(ApiError::new(
                413,
                "网站项目最多 10 MiB，每个文件最多 4 MiB。",
            ));
        }
        total += length;
        let mut bytes = Vec::with_capacity(length as usize);
        while let Some(chunk) = reader.next()? {
            bytes.extend(chunk);
        }
        if digest(&bytes) != sha256 {
            return Err(changed());
        }
        let (mime, text) = asset_type(&path).ok_or_else(invalid)?;
        if text && (bytes.contains(&0) || std::str::from_utf8(&bytes).is_err()) {
            return Err(invalid());
        }
        captured.push((
            Asset {
                path,
                mime: mime.into(),
                size: bytes.len(),
                sha256,
            },
            bytes,
        ));
    }
    Ok(captured)
}

pub async fn manifest(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let response = manifest_response(&mut *store.pool.acquire().await?, &id).await?;
    grant.authorize(&state).await?;
    Ok(response)
}

pub(super) async fn manifest_response(conn: &mut SqliteConnection, id: &str) -> Result<Response> {
    let manifest = find(conn, id).await?.ok_or_else(missing)?;
    Ok(harden(Json(manifest).into_response()))
}

pub async fn file(
    Extract(state): Extract<State>,
    Path((wid, id, path)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let response = asset_response(&mut *store.pool.acquire().await?, &id, &path).await?;
    grant.authorize(&state).await?;
    Ok(response)
}

pub(super) async fn asset_response(
    conn: &mut SqliteConnection,
    id: &str,
    path: &str,
) -> Result<Response> {
    if !portable_path(&path) {
        return Err(missing());
    }
    let manifest = find(conn, id).await?.ok_or_else(missing)?;
    let asset = manifest
        .files
        .iter()
        .find(|asset| asset.path == path)
        .ok_or_else(missing)?;
    let bytes: Vec<u8> =
        sqlx::query_scalar("SELECT bytes FROM website_project_files WHERE project_id=? AND path=?")
            .bind(id)
            .bind(path)
            .fetch_optional(conn)
            .await?
            .ok_or_else(missing)?;
    if bytes.len() != asset.size || bytes.len() > MAX_FILE_BYTES {
        return Err(changed());
    }
    attachment(
        bytes,
        "application/octet-stream",
        path.rsplit('/').next().unwrap_or("asset"),
    )
}

pub(super) async fn share_scope(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<(String, Option<String>)> {
    let summary = find(conn, id).await?.ok_or_else(missing)?.summary;
    let publisher =
        sqlx::query_scalar("SELECT user_id FROM website_project_publishers WHERE project_key=?")
            .bind(&summary.project_key)
            .fetch_optional(conn)
            .await?;
    Ok((summary.project_key, publisher))
}

pub async fn download(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut conn = store.pool.acquire().await?;
    let manifest = find(&mut conn, &id).await?.ok_or_else(missing)?;
    let rows = sqlx::query(
        "SELECT path,bytes FROM website_project_files WHERE project_id=? ORDER BY path",
    )
    .bind(&id)
    .fetch_all(&mut *conn)
    .await?;
    drop(conn);
    if rows.len() != manifest.files.len() {
        return Err(changed());
    }
    let mut files = Vec::with_capacity(rows.len());
    let mut total = 0;
    for (row, asset) in rows.into_iter().zip(manifest.files) {
        let path: String = row.try_get("path")?;
        let bytes: Vec<u8> = row.try_get("bytes")?;
        if path != asset.path
            || !portable_path(&path)
            || bytes.len() != asset.size
            || bytes.len() > MAX_FILE_BYTES
        {
            return Err(changed());
        }
        total += bytes.len();
        files.push((path, bytes));
    }
    if total != manifest.summary.total_bytes {
        return Err(changed());
    }
    grant.authorize(&state).await?;
    let bytes = tokio::task::spawn_blocking(move || super::website_zip::archive(files))
        .await
        .map_err(|_| changed())?;
    grant.authorize(&state).await?;
    attachment(
        bytes,
        "application/zip",
        &format!("website-{}.zip", &id[..12]),
    )
}

fn harden(mut response: Response) -> Response {
    let headers = response.headers_mut();
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
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    response
}

fn attachment(bytes: Vec<u8>, mime: &'static str, name: &str) -> Result<Response> {
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
        .map_err(|_| invalid())?;
    let mut response = bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition);
    Ok(harden(response))
}
