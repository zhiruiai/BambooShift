use crate::error::{ApiError, Result};
use std::{io::Read, net::SocketAddr, path::PathBuf};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationsConfig {
    pub bind: SocketAddr,
    pub public_origin: Option<String>,
    pub web_origin: Option<String>,
}

#[derive(Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub bind: SocketAddr,
    pub public_origin: Option<String>,
    pub web_origin: Option<String>,
    pub runtime_dir: PathBuf,
    pub node_binary: PathBuf,
    pub operations: Option<OperationsConfig>,
    pub releases: Option<crate::updates::ReleasesConfig>,
}
impl Config {
    pub fn from_private_file(path: &std::path::Path) -> Result<Self> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct FileConfig {
            data_dir: PathBuf,
            bind: Option<SocketAddr>,
            public_origin: Option<String>,
            web_origin: Option<String>,
            runtime_dir: Option<PathBuf>,
            node_binary: Option<PathBuf>,
            operations: Option<OperationsConfig>,
            releases: Option<crate::updates::ReleasesConfig>,
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file() || metadata.len() > 16384 {
            return Err(ApiError::bad("私有服务配置文件无效。"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(ApiError::bad("私有服务配置必须仅当前用户可读写。"));
            }
        }
        let mut bytes = Vec::new();
        file.by_ref().take(16385).read_to_end(&mut bytes)?;
        if bytes.len() > 16384 {
            return Err(ApiError::bad("私有服务配置过大。"));
        }
        let parsed: FileConfig =
            serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("私有服务配置格式无效。"))?;
        let mut config = Self::local(parsed.data_dir);
        if let Some(bind) = parsed.bind {
            config.bind = bind;
        }
        config.public_origin = parsed.public_origin;
        config.web_origin = parsed.web_origin;
        config.operations = parsed.operations;
        config.releases = parsed.releases;
        if let Some(runtime) = parsed.runtime_dir {
            config.runtime_dir = runtime;
        }
        if let Some(node) = parsed.node_binary {
            config.node_binary = node;
        }
        config.validate()?;
        Ok(config)
    }
    pub fn local(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            bind: "127.0.0.1:3002".parse().unwrap(),
            public_origin: None,
            web_origin: None,
            runtime_dir: default_runtime(),
            node_binary: PathBuf::from("node"),
            operations: None,
            releases: None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.data_dir.as_os_str().is_empty() {
            return Err(ApiError::bad("必须明确配置私有数据目录。"));
        }
        if !self.runtime_dir.is_absolute()
            || !self.runtime_dir.is_dir()
            || self.node_binary.as_os_str().is_empty()
        {
            return Err(ApiError::bad("执行环境路径无效，请检查私有服务配置。"));
        }
        validate_endpoint(self.bind, &self.public_origin, &self.web_origin)?;
        if self
            .releases
            .as_ref()
            .is_some_and(|value| !crate::updates::valid_repository(&value.repository))
        {
            return Err(ApiError::bad("更新仓库必须是有效的 GitHub owner/repo。"));
        }
        if let Some(operations) = &self.operations {
            validate_endpoint(
                operations.bind,
                &operations.public_origin,
                &operations.web_origin,
            )?;
            if self.bind == operations.bind && self.bind.port() != 0 {
                return Err(ApiError::bad("产品与运营入口必须使用不同监听地址。"));
            }
            let product = [self.public_origin.as_deref(), self.web_origin.as_deref()];
            if [
                operations.public_origin.as_deref(),
                operations.web_origin.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|origin| product.contains(&Some(origin)))
            {
                return Err(ApiError::bad("产品与运营入口必须使用不同页面来源。"));
            }
        }
        Ok(())
    }
    fn secure_cookie(&self, purpose: &str) -> bool {
        if purpose == "operator" {
            if let Some(operations) = &self.operations {
                return operations.public_origin.is_some();
            }
        }
        self.public_origin.is_some()
    }
    pub fn cookie_name(&self, purpose: &str) -> String {
        format!(
            "{}openbot_{purpose}",
            if self.secure_cookie(purpose) {
                "__Host-"
            } else {
                ""
            }
        )
    }
    pub fn cookie(&self, purpose: &str, token: &str) -> String {
        let age = if token.is_empty() {
            0
        } else if purpose == "operator" {
            43200
        } else {
            2592000
        };
        format!(
            "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}{}",
            self.cookie_name(purpose),
            if self.secure_cookie(purpose) {
                "; Secure"
            } else {
                ""
            }
        )
    }
}

fn default_runtime() -> PathBuf {
    const SOURCE_ENTRY: &str = "server/workers/pi-worker/index.ts";
    let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    if current.join(SOURCE_ENTRY).is_file() {
        return current;
    }
    if current.ends_with("server/api") {
        if let Some(root) = current.parent().and_then(std::path::Path::parent) {
            if root.join(SOURCE_ENTRY).is_file() {
                return root.to_owned();
            }
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|file| file.parent().map(|directory| directory.join("runtime")))
        .unwrap_or(current)
}

fn validate_endpoint(
    bind: SocketAddr,
    public: &Option<String>,
    web: &Option<String>,
) -> Result<()> {
    if !bind.ip().is_loopback() {
        return Err(ApiError::bad(
            "Rust 服务必须绑定本机，由 HTTPS 代理提供远程访问。",
        ));
    }
    for (origin, https_only) in [(public, true), (web, false)] {
        if let Some(origin) = origin {
            let parsed = url::Url::parse(origin).map_err(|_| ApiError::bad("服务地址无效。"))?;
            if (https_only && parsed.scheme() != "https")
                || !["http", "https"].contains(&parsed.scheme())
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.origin().ascii_serialization() != *origin
            {
                return Err(ApiError::bad("服务地址必须是有效的独立 origin。"));
            }
        }
    }
    Ok(())
}
