use super::model::SavedRemote;
use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedConnection {
    pub version: u8,
    pub selection: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<SavedRemote>,
}
pub fn read(directory: &Path) -> Result<Option<SavedConnection>> {
    let path = directory.join("computer/connection.json");
    let Some(bytes) = read_private(&path, 64 * 1024)? else {
        return Ok(None);
    };
    let saved: SavedConnection = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if saved.version != 1
        || !["local", "remote", "disconnected"].contains(&saved.selection.as_str())
        || (saved.selection == "remote" && saved.remote.is_none())
    {
        return Err(invalid());
    }
    if let Some(remote) = &saved.remote {
        remote.validate()?;
    }
    Ok(Some(saved))
}
pub fn write(directory: &Path, saved: &SavedConnection) -> Result<()> {
    atomic_private(
        &directory.join("computer/connection.json"),
        &serde_json::to_vec(saved).map_err(|_| invalid())?,
    )
}
pub fn read_private(path: &Path, limit: usize) -> Result<Option<Vec<u8>>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(invalid());
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let stat = file.metadata()?;
        if stat.ino() != metadata.ino() || stat.dev() != metadata.dev() {
            return Err(invalid());
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(invalid());
        }
        Ok(Some(bytes))
    }
    #[cfg(not(unix))]
    {
        Ok(Some(std::fs::read(path)?))
    }
}
pub fn atomic_private(path: &Path, bytes: &[u8]) -> Result<()> {
    crate::filesystem::write_private(path, bytes)?;
    Ok(())
}

fn invalid() -> ApiError {
    ApiError::new(409, "电脑私有配置不可用，请检查部署配置。")
}
