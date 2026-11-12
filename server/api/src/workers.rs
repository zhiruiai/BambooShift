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
    if selected.is_absolute() {
        return if selected.is_file() {
            Ok(selected)
        } else {
            Err(unavailable())
        };
    }
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|p| p.join(&selected))
                .find(|p| p.is_file())
        })
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
            command.arg("--import").arg(loader);
        }
        command.arg(source);
    }
    command
        .current_dir(&config.runtime_dir)
        .env_clear()
        .env("LANG", "en_US.UTF-8");
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> (tempfile::TempDir, Config) {
        let d = tempfile::tempdir().unwrap();
        let mut c = Config::local(d.path().join("data"));
        c.runtime_dir = d.path().to_owned();
        c.node_binary = std::env::current_exe().unwrap();
        (d, c)
    }
    #[test]
    fn bundle_wins_without_a_source_tree_or_tsx_and_development_uses_only_the_explicit_loader() {
        let (_d, c) = config();
        let base = c.runtime_dir.join("packages/pi-worker");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("index.mjs"), "").unwrap();
        let built = command(&c, Worker::Agent, &["--max-old-space-size=192"]).unwrap();
        let args = built
            .as_std()
            .get_args()
            .map(|v| v.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "--max-old-space-size=192".to_owned(),
                base.join("index.mjs").to_string_lossy().to_string()
            ]
        );
        assert!(built.as_std().get_envs().all(|(key, _)| key == "LANG"));
        std::fs::remove_file(base.join("index.mjs")).unwrap();
        let source = c.runtime_dir.join("server/workers/pi-worker/index.ts");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "").unwrap();
        assert!(command(&c, Worker::Agent, &[]).is_err());
        let loader = c.runtime_dir.join("node_modules/tsx/dist/loader.mjs");
        std::fs::create_dir_all(loader.parent().unwrap()).unwrap();
        std::fs::write(&loader, "").unwrap();
        let dev = command(&c, Worker::Agent, &[]).unwrap();
        let args = dev.as_std().get_args().collect::<Vec<_>>();
        assert_eq!(args[0], "--import");
        assert_eq!(args[1], loader);
        assert_eq!(args[2], source);
    }
    #[test]
    fn malformed_bundle_never_silently_falls_back_and_document_source_has_no_loader() {
        let (_d, c) = config();
        let base = c.runtime_dir.join("packages/document-worker");
        std::fs::create_dir_all(&base).unwrap();
        let source = c
            .runtime_dir
            .join("server/workers/document-worker/index.ts");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "").unwrap();
        let dev = command(&c, Worker::Document, &[]).unwrap();
        assert_eq!(
            dev.as_std().get_args().next().unwrap(),
            "--experimental-strip-types"
        );
        std::fs::create_dir(base.join("index.mjs")).unwrap();
        assert!(command(&c, Worker::Document, &[]).is_err());
        #[cfg(unix)]
        {
            std::fs::remove_dir(base.join("index.mjs")).unwrap();
            std::os::unix::fs::symlink("missing.mjs", base.join("index.mjs")).unwrap();
            assert!(command(&c, Worker::Document, &[]).is_err());
        }
    }
}
