use super::{model, private_config};
use crate::error::{ApiError, Result};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudBinding {
    pub version: u8,
    pub provider: String,
    pub workspace_id: String,
    pub name: String,
    pub api_base_url: String,
    pub sandbox_id: String,
    pub template_id: Option<String>,
    pub worker_url: String,
    pub api_key: Option<String>,
    pub bridge_config_path: Option<PathBuf>,
    pub auto_resume: bool,
}
pub fn read(directory: &Path, workspace: &str) -> Result<Option<CloudBinding>> {
    let Some(bytes) = private_config::read_private(&directory.join("computer/cloud.json"), 65536)?
    else {
        return Ok(None);
    };
    let config: CloudBinding = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let origin = url::Url::parse(&config.api_base_url).map_err(|_| invalid())?;
    if config.version != 1
        || config.provider != "cubesandbox"
        || config.workspace_id != workspace
        || config.auto_resume
        || !["http", "https"].contains(&origin.scheme())
        || !matches!(origin.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || origin.origin().ascii_serialization() != config.api_base_url
        || config.name.trim().is_empty()
        || config.name.encode_utf16().count() > 100
        || !identifier(&config.sandbox_id, 64)
        || config
            .template_id
            .as_ref()
            .is_some_and(|v| !identifier(v, 100))
        || config.api_key.as_ref().is_some_and(|v| !secret(v))
        || config
            .bridge_config_path
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
    {
        return Err(invalid());
    }
    model::worker_url(&config.worker_url)?;
    Ok(Some(config))
}
fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'-')
}
fn secret(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.bytes().all(|b| (33..=126).contains(&b))
}
pub fn merge_credentials(config: &CloudBinding, response: &Value) -> Result<()> {
    let Some(value) = response.get("trafficAccessToken").filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let token = value.as_str().filter(|v| secret(v)).ok_or_else(invalid)?;
    let path = config.bridge_config_path.as_ref().ok_or_else(|| {
        ApiError::new(502, "云电脑凭据需要由管理员更新。").with_code("CLOUD_BRIDGE_REQUIRED")
    })?;
    let bytes = private_config::read_private(path, 65536)?.ok_or_else(invalid)?;
    let mut current: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if current["sandboxID"] != config.sandbox_id
        || response
            .get("domain")
            .is_some_and(|domain| !domain.is_null() && domain != &current["domain"])
    {
        return Err(invalid());
    }
    if current["trafficAccessToken"] == token {
        return Ok(());
    }
    current["trafficAccessToken"] = Value::String(token.into());
    private_config::atomic_private(path, &serde_json::to_vec(&current).map_err(|_| invalid())?)
}
pub fn invalid() -> ApiError {
    ApiError::new(409, "云电脑私有配置不可用，请联系空间管理员。").with_code("CLOUD_CONFIG_INVALID")
}
