use crate::{
    config::Config,
    error::{ApiError, Result},
};
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Clone, Copy)]
pub(crate) enum Worker {
    Agent,
    Mcp,
    Computer,
    Document,
}
impl Worker {
    fn name(self) -> &'static str {
        match self {
            // Keep existing release and development entrypoint paths compatible.
            Self::Agent => "pi",
            Self::Mcp => "mcp",
            Self::Computer => "computer",
            Self::Document => "document",
        }
    }
    fn source(self) -> &'static str {
        if matches!(self, Self::Computer) {
            "local-entry.ts"
        } else {
            "index.ts"
        }
    }
}
fn regular(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}
fn node(config: &Config) -> Result<PathBuf> {
    let selected = if config.node_binary == Path::new("node") {
        std::env::var_os("OPENBOT_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.node_binary.clone())
    } else {
        config.node_binary.clone()
    };
    let paths = std::env::var_os("PATH").unwrap_or_default();
    let base = std::env::current_dir().map_err(|_| unavailable())?;
    crate::executable::resolve(
        &selected,
        std::env::split_paths(&paths),
        &base,
        std::env::consts::EXE_SUFFIX,
    )
    .ok_or_else(unavailable)
}
fn unavailable() -> ApiError {
    ApiError::new(503, "执行环境不完整，请检查 Node 与已发布的工作进程配置。")
        .with_code("WORKER_UNAVAILABLE")
}

/// Released bundles need only their pinned production dependencies, never tsx or a business server.
pub(crate) fn command(config: &Config, worker: Worker, node_options: &[&str]) -> Result<Command> {
    let name = format!("{}-worker", worker.name());
    let bundle = config
        .runtime_dir
        .join("packages")
        .join(&name)
        .join("index.mjs");
    let mut command = Command::new(node(config)?);
    command.args(node_options);
    let has_bundle = match std::fs::symlink_metadata(&bundle) {
        Ok(metadata) if metadata.is_file() => true,
        Ok(_) => return Err(unavailable()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(unavailable()),
    };
    if has_bundle {
        command.arg(bundle);
    } else {
        let source = config
            .runtime_dir
            .join("server/workers")
            .join(name)
            .join(worker.source());
        if !regular(&source) {
            return Err(unavailable());
        }
        if matches!(worker, Worker::Document) {
            command.arg("--experimental-strip-types");
        } else {
            let loader = config.runtime_dir.join("node_modules/tsx/dist/loader.mjs");
            if !loader.is_file() {
                return Err(unavailable());
            }
            let specifier = url::Url::from_file_path(&loader).map_err(|_| unavailable())?;
            command.arg("--import").arg(specifier.as_str());
        }
        command.arg(source);
    }
    command
        .current_dir(&config.runtime_dir)
        .env_clear()
        .env("LANG", "en_US.UTF-8");
    #[cfg(windows)]
    {
        // Winsock expands %SystemRoot% when loading its providers. The source
        // loader also needs a writable temp directory for TypeScript transforms.
        let system_root = std::env::var_os("SystemRoot").ok_or_else(unavailable)?;
        let temporary = std::env::temp_dir();
        command
            .env("SystemRoot", system_root)
            .env("TEMP", &temporary)
            .env("TMP", temporary);
    }
    Ok(command)
}

#[cfg(test)]
#[path = "../tests/unit/workers.rs"]
mod tests;
