use crate::error::{ApiError, Result};
use serde::Deserialize;
use std::{
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    pub version: u8,
    pub enabled: bool,
    pub binary_path: PathBuf,
    pub model_path: PathBuf,
    pub voice_model_path: Option<PathBuf>,
    pub threads: u8,
}
impl Config {
    pub fn voice_model(&self) -> Result<&Path> {
        let model = self.voice_model_path.as_deref().unwrap_or(&self.model_path);
        if !model.is_absolute()
            || !std::fs::metadata(model).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
        {
            return Err(unavailable());
        }
        Ok(model)
    }
}
pub(super) fn unavailable() -> ApiError {
    ApiError::new(503, "本地语音识别暂不可用，请联系管理员检查配置。")
        .with_code("SPEECH_UNAVAILABLE")
}
pub(super) fn read(root: &Path) -> Result<Config> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(root.join("speech/config.json"))
        .map_err(|_| unavailable())?;
    let meta = file.metadata().map_err(|_| unavailable())?;
    if !meta.is_file() || meta.len() > 16384 {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.mode() & 0o077 != 0 || meta.uid() != unsafe { libc::geteuid() } {
            return Err(unavailable());
        }
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if config.version != 1
        || !config.enabled
        || !(1..=8).contains(&config.threads)
        || !config.binary_path.is_absolute()
        || !config.model_path.is_absolute()
    {
        return Err(unavailable());
    }
    let binary = std::fs::metadata(&config.binary_path).map_err(|_| unavailable())?;
    let model = std::fs::metadata(&config.model_path).map_err(|_| unavailable())?;
    if !binary.is_file() || !model.is_file() || model.len() == 0 {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if binary.permissions().mode() & 0o111 == 0 {
            return Err(unavailable());
        }
    }
    Ok(config)
}
