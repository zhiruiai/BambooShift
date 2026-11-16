use super::{Table, WorkspaceStore, access, mutations};
use crate::{
    db::State,
    error::{ApiError, Result, only_fields},
};
use axum::{
    extract::{Path, State as Extract},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::collections::{BTreeMap, HashSet};

const MAX_PACKAGE_BYTES: usize = 1024 * 1024;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_FILES: usize = 64;
const RESOURCE_PAGE: usize = 12_000;
pub(crate) const TEXT_SOURCE: &str = "workspace-text";

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS skill_package_files (skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE, path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(skill_id,path))")
        .execute(conn).await?;
    Ok(())
}

pub(super) async fn backfill_text(conn: &mut SqliteConnection) -> Result<()> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM skills WHERE json_type(data,'$.skillPackage') IS NULL OR json_type(data,'$.skillPackage')='null'",
    )
    .fetch_all(&mut *conn)
    .await?;
    for row in rows {
        let mut skill: Value = serde_json::from_str(&row).map_err(|_| invalid())?;
        let Ok(package) = Package::from_text(&skill) else {
            // Older stores may contain text outside the portable format's bounds.
            // Leave that original record readable.
            continue;
        };
        skill["skillPackageSource"] = json!(TEXT_SOURCE);
        persist(conn, &mut skill, package).await?;
    }
    Ok(())
}

fn invalid() -> ApiError {
    ApiError::bad("Agent Skill 技能包格式无效，请检查名称、清单和相对路径。")
        .with_code("INVALID_SKILL_PACKAGE")
}

fn missing() -> ApiError {
    ApiError::new(404, "没有找到此技能版本的包资源。").with_code("SKILL_RESOURCE_NOT_FOUND")
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .chars()
            .all(|c| c == '-' || c.is_alphanumeric() && !c.is_uppercase())
        && value == value.to_lowercase()
}

fn portable_text_name(title: &str) -> String {
    let words = title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    let prefix = words[..words.len().min(40)].trim_end_matches('-');
    let prefix = if prefix.is_empty() { "skill" } else { prefix };
    let digest = hex::encode(Sha256::digest(title));
    format!("{prefix}-{}", &digest[..16])
}

pub(crate) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 320
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && !part.ends_with(['.', ' ']))
}

fn string(value: &Value, maximum: usize) -> Result<&str> {
    value
        .as_str()
        .filter(|value| {
            !value.trim().is_empty() && value.chars().count() <= maximum && !value.contains('\0')
        })
        .ok_or_else(invalid)
}

fn yaml_string(value: &str) -> String {
    // JSON's quoted scalar syntax is also YAML. Escape the document separator
    // spelling to keep compatibility with validators that split at that token.
    json!(value)
        .to_string()
        .replace("---", "\\u002d\\u002d\\u002d")
        .replace('\u{0085}', "\\u0085")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

pub(super) struct Package {
    pub name: String,
    pub description: String,
    pub content: String,
    frontmatter: Value,
    files: BTreeMap<String, Vec<u8>>,
}

impl Package {
    fn from_text(skill: &Value) -> Result<Self> {
        let title = string(&skill["name"], 100)?;
        let name = portable_text_name(title);
        let description = skill["description"]
            .as_str()
            .filter(|description| {
                !description.trim().is_empty()
                    && !description.contains('\0')
                    && description.chars().count() <= 1024
            })
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Reusable workflow: {title}"));
        Self::parse(
            &json!({"name":name,"description":description,"content":skill["content"]}),
            &json!({"root":name,"frontmatter":{"metadata":{"title":title}},"files":[]}),
        )
    }

    pub(super) fn parse(body: &Value, package: &Value) -> Result<Self> {
        only_fields(package, &["root", "frontmatter", "files"]).map_err(|_| invalid())?;
        let name = body["name"]
            .as_str()
            .filter(|value| valid_name(value))
            .ok_or_else(invalid)?;
        if package["root"] != name {
            return Err(invalid());
        }
        let description = string(&body["description"], 1024)?;
        let content = body["content"]
            .as_str()
            .filter(|value| value.len() <= 64 * 1024 && !value.contains('\0'))
            .ok_or_else(invalid)?;
        let extra = &package["frontmatter"];
        only_fields(
            extra,
            &["license", "compatibility", "metadata", "allowed-tools"],
        )
        .map_err(|_| invalid())?;
        let mut frontmatter = json!({"name":name,"description":description});
        for (field, limit) in [
            ("license", 1024),
            ("compatibility", 500),
            ("allowed-tools", 4096),
        ] {
            if let Some(value) = extra.get(field) {
                frontmatter[field] = json!(string(value, limit)?);
            }
        }
        if let Some(metadata) = extra.get("metadata") {
            let map = metadata
                .as_object()
                .filter(|map| map.len() <= 32)
                .ok_or_else(invalid)?;
            if map.iter().any(|(key, value)| {
                key.len() > 128
                    || key.contains('\0')
                    || !value
                        .as_str()
                        .is_some_and(|value| value.len() <= 1024 && !value.contains('\0'))
            }) {
                return Err(invalid());
            }
            if !map.is_empty() {
                frontmatter["metadata"] = metadata.clone();
            }
        }
        let mut files = BTreeMap::new();
        let mut primary = String::from("---\n");
        for (key, value) in frontmatter.as_object().unwrap() {
            if let Some(entries) = value.as_object() {
                primary.push_str(&format!("{key}:\n"));
                for (key, value) in entries {
                    primary.push_str(&format!(
                        "  {}: {}\n",
                        yaml_string(key),
                        yaml_string(value.as_str().unwrap())
                    ));
                }
            } else {
                primary.push_str(&format!(
                    "{key}: {}\n",
                    yaml_string(value.as_str().unwrap())
                ));
            }
        }
        primary.push_str("---\n");
        primary.push_str(content);
        let mut total = primary.len();
        files.insert("SKILL.md".into(), primary.into_bytes());
        let resources = package["files"]
            .as_array()
            .filter(|files| files.len() < MAX_FILES)
            .ok_or_else(invalid)?;
        for file in resources {
            only_fields(file, &["path", "base64"]).map_err(|_| invalid())?;
            let path = file["path"]
                .as_str()
                .filter(|path| valid_path(path))
                .ok_or_else(invalid)?;
            let encoded = file["base64"]
                .as_str()
                .filter(|value| value.len() <= MAX_FILE_BYTES.div_ceil(3) * 4)
                .ok_or_else(invalid)?;
            let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
            total += bytes.len();
            if bytes.len() > MAX_FILE_BYTES || total > MAX_PACKAGE_BYTES || files.contains_key(path)
            {
                return Err(invalid());
            }
            files.insert(path.to_owned(), bytes);
        }
        let portable_paths: HashSet<_> = files.keys().map(|path| path.to_lowercase()).collect();
        if portable_paths.len() != files.len() {
            return Err(invalid());
        }
        for path in &portable_paths {
            if path
                .match_indices('/')
                .any(|(end, _)| portable_paths.contains(&path[..end]))
            {
                return Err(invalid());
            }
        }
        Ok(Self {
            name: name.to_owned(),
            description: description.to_owned(),
            content: content.to_owned(),
            frontmatter,
            files,
        })
    }

    pub(super) fn manifest(&self) -> Value {
        let files: Vec<_> = self
            .files
            .iter()
            .map(|(path, bytes)| {
                json!({
                    "path":path,"size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))
                })
            })
            .collect();
        json!({"format":"agent-skills","root":self.name,"frontmatter":self.frontmatter,"files":files})
    }

    pub(super) async fn save(self, conn: &mut SqliteConnection, id: &str) -> Result<()> {
        save_files(conn, id, self.files).await
    }
}

async fn save_files(
    conn: &mut SqliteConnection,
    id: &str,
    files: impl IntoIterator<Item = (String, Vec<u8>)>,
) -> Result<()> {
    for (path, bytes) in files {
        sqlx::query("INSERT INTO skill_package_files(skill_id,path,content) VALUES(?,?,?)")
            .bind(id)
            .bind(path)
            .bind(bytes)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

pub(super) async fn persist(
    conn: &mut SqliteConnection,
    skill: &mut Value,
    package: Package,
) -> Result<()> {
    skill["skillPackage"] = package.manifest();
    WorkspaceStore::put_in(conn, Table::Skills, skill).await?;
    let id = skill["id"].as_str().ok_or_else(invalid)?;
    package.save(conn, id).await
}

pub(crate) async fn persist_text(conn: &mut SqliteConnection, skill: &mut Value) -> Result<()> {
    let prior: Option<String> = sqlx::query_scalar(
        "SELECT data FROM skills WHERE json_extract(data,'$.agentId')=? AND json_extract(data,'$.name')=? ORDER BY (json_extract(data,'$.status')='active') DESC, json_extract(data,'$.version') DESC LIMIT 1",
    )
    .bind(skill["agentId"].as_str())
    .bind(skill["name"].as_str())
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(prior) = prior {
        let prior: Value = serde_json::from_str(&prior).map_err(|_| invalid())?;
        if prior["skillPackage"]["files"]
            .as_array()
            .is_some_and(|files| files.iter().any(|file| file["path"] != "SKILL.md"))
        {
            return Err(ApiError::new(
                409,
                "此技能版本包含资源文件。请导入包含这些资源的完整技能包来更新。",
            )
            .with_code("SKILL_PACKAGE_REQUIRED"));
        }
    }
    let package = Package::from_text(skill)?;
    skill["skillPackageSource"] = json!(TEXT_SOURCE);
    persist(conn, skill, package).await
}

pub(crate) async fn verified_files(
    conn: &mut SqliteConnection,
    id: &str,
    package: &Value,
) -> Result<Vec<(String, Vec<u8>)>> {
    if package["format"] != "agent-skills" || !package["root"].as_str().is_some_and(valid_name) {
        return Err(missing());
    }
    let manifest = package["files"].as_array().ok_or_else(missing)?;
    let files: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT path, content FROM skill_package_files WHERE skill_id=? ORDER BY path",
    )
    .bind(id)
    .fetch_all(conn)
    .await?;
    if files.is_empty()
        || files.len() != manifest.len()
        || !files.iter().any(|(path, _)| path == "SKILL.md")
        || !files.iter().zip(manifest).all(|((path, bytes), file)| {
            valid_path(path)
                && file["path"] == *path
                && file["size"] == bytes.len()
                && file["sha256"] == hex::encode(Sha256::digest(bytes))
        })
    {
        return Err(missing());
    }
    Ok(files)
}

pub(crate) async fn duplicate(
    conn: &mut SqliteConnection,
    source: &Value,
    target: &mut Value,
) -> Result<()> {
    let id = source["id"].as_str().ok_or_else(missing)?;
    let package = &source["skillPackage"];
    let files = verified_files(conn, id, package).await?;
    for key in ["name", "description", "content", "skillPackage"] {
        target[key] = source[key].clone();
    }
    if let Some(origin) = source.get("skillPackageSource") {
        target["skillPackageSource"] = origin.clone();
    }
    WorkspaceStore::put_in(conn, Table::Skills, target).await?;
    save_files(conn, target["id"].as_str().ok_or_else(invalid)?, files).await
}

pub(crate) async fn read_resource(
    store: &WorkspaceStore,
    skills: &[Value],
    args: &Value,
) -> Result<Value> {
    only_fields(args, &["skillId", "path", "offset"]).map_err(|_| invalid())?;
    let id = args["skillId"].as_str().ok_or_else(invalid)?;
    let path = args["path"]
        .as_str()
        .filter(|path| valid_path(path))
        .ok_or_else(invalid)?;
    let offset = match args.get("offset") {
        Some(value) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(invalid)?,
        None => 0,
    };
    let file = skills
        .iter()
        .find(|skill| skill["id"] == id)
        .and_then(|skill| skill["skillPackage"]["files"].as_array())
        .and_then(|files| files.iter().find(|file| file["path"] == path))
        .ok_or_else(missing)?;
    let bytes: Vec<u8> =
        sqlx::query_scalar("SELECT content FROM skill_package_files WHERE skill_id=? AND path=?")
            .bind(id)
            .bind(path)
            .fetch_optional(&store.pool)
            .await?
            .ok_or_else(missing)?;
    if file["sha256"] != hex::encode(Sha256::digest(&bytes)) {
        return Err(missing());
    }
    let (content, encoding, end) = if let Ok(text) = std::str::from_utf8(&bytes) {
        if !text.is_char_boundary(offset) {
            return Err(invalid());
        }
        let mut end = (offset + RESOURCE_PAGE).min(bytes.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        (text[offset..end].to_owned(), "utf8", end)
    } else {
        let page = bytes.get(offset..).ok_or_else(invalid)?;
        let size = page.len().min(RESOURCE_PAGE);
        (STANDARD.encode(&page[..size]), "base64", offset + size)
    };
    Ok(
        json!({"skillId":id,"path":path,"encoding":encoding,"content":content,
        "offset":offset,"nextOffset":(end < bytes.len()).then_some(end)}),
    )
}

pub(super) async fn download(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let grant = access::require(&state, &headers, &wid, true, false).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.pool.begin().await?;
    let skill = mutations::find(&mut tx, Table::Skills, &id).await?;
    let root = skill["skillPackage"]["root"]
        .as_str()
        .filter(|root| valid_name(root))
        .ok_or_else(missing)?;
    let files = verified_files(&mut tx, &id, &skill["skillPackage"]).await?;
    tx.commit().await?;
    let files = files
        .into_iter()
        .map(|(path, bytes)| (format!("{root}/{path}"), bytes))
        .collect();
    let bytes = tokio::task::spawn_blocking(move || super::website_zip::archive(files))
        .await
        .map_err(|_| ApiError::new(500, "无法打包此技能版本。"))?;
    grant.authorize(&state).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=agent-skill.zip",
            ),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}
