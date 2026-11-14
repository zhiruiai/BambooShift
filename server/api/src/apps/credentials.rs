use crate::error::{ApiError, Result};
use crate::workspace::WorkspaceStore;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Read,
};

fn path(store: &WorkspaceStore) -> std::path::PathBuf {
    store.directory.join("config/apps.private.json")
}
fn document(store: &WorkspaceStore) -> Result<Value> {
    let directory = store.directory.join("config");
    match fs::symlink_metadata(&directory) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            return Err(ApiError::new(409, "私有应用配置目录不可用。"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"version":1,"entries":{}}));
        }
        Err(e) => return Err(e.into()),
    };
    let path = path(store);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"version":1,"entries":{}}));
        }
        Err(e) => return Err(e.into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4 * 1024 * 1024 {
        return Err(ApiError::new(409, "私有应用配置不可用。"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.nlink() != 1 || meta.permissions().mode() & 0o077 != 0 {
            return Err(ApiError::new(409, "私有应用配置权限无效。"));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let held = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if held.dev() != meta.dev() || held.ino() != meta.ino() || held.nlink() != 1 {
            return Err(ApiError::new(409, "私有应用配置在读取时发生变化。"));
        }
    }
    let mut text = String::new();
    file.take(4 * 1024 * 1024 + 1).read_to_string(&mut text)?;
    if text.len() > 4 * 1024 * 1024 {
        return Err(ApiError::new(413, "私有应用配置过大。"));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|_| ApiError::new(409, "私有应用配置损坏。"))?;
    if value["version"] != 1 || !value["entries"].is_object() {
        return Err(ApiError::new(409, "私有应用配置格式无效。"));
    }
    Ok(value)
}
fn write(store: &WorkspaceStore, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| ApiError::new(409, "私有应用配置无效。"))?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(ApiError::new(413, "私有应用配置数量过多。"));
    }
    crate::filesystem::write_private(&path(store), &bytes)?;
    Ok(())
}
pub async fn stage(store: &WorkspaceStore, owner: &str, payload: &Value) -> Result<String> {
    let _lock = store.credential_lock.lock().await;
    let mut doc = document(store)?;
    let id = uuid::Uuid::new_v4().to_string();
    doc["entries"][&id] = json!({"workspace":store.workspace_id,"owner":owner,"payload":payload});
    write(store, &doc)?;
    Ok(id)
}
pub fn read(store: &WorkspaceStore, owner: &str, reference: Option<&str>) -> Result<Value> {
    let Some(reference) = reference else {
        return Ok(json!({}));
    };
    let doc = document(store)?;
    let entry = &doc["entries"][reference];
    if entry["workspace"] != store.workspace_id || entry["owner"] != owner {
        return Err(ApiError::new(409, "应用凭据已失效。"));
    }
    Ok(entry["payload"].clone())
}
pub async fn remove(store: &WorkspaceStore, reference: Option<&str>) -> Result<()> {
    let Some(reference) = reference else {
        return Ok(());
    };
    let _lock = store.credential_lock.lock().await;
    let mut doc = document(store)?;
    if let Some(entries) = doc["entries"].as_object_mut() {
        entries.remove(reference);
    }
    write(store, &doc)
}
pub fn secrets(payload: &Value) -> Vec<String> {
    [
        payload["token"].as_str(),
        payload["grant"]["tokens"]["access_token"].as_str(),
        payload["grant"]["tokens"]["refresh_token"].as_str(),
        payload["grant"]["client"]["client_secret"].as_str(),
    ]
    .into_iter()
    .flatten()
    .map(str::to_owned)
    .collect()
}

/// Read legacy source credentials in memory without initializing or rewriting its store.
pub fn payload(store: &WorkspaceStore, saved: &super::model::Connection) -> Result<Value> {
    if saved.credential_ref.is_some() {
        read(store, &saved.id, saved.credential_ref.as_deref())
    } else {
        Ok(json!({"token":saved.legacy_token,"grant":saved.legacy_grant}))
    }
}
