use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Child,
    sync::watch,
};

pub struct LocalExecutor {
    pub url: String,
    pub token: String,
    stop: watch::Sender<bool>,
    done: watch::Receiver<Option<bool>>,
}
impl LocalExecutor {
    pub async fn start(
        config: &crate::config::Config,
        directory: &Path,
        workspace: &str,
        origin: Option<&str>,
    ) -> Result<Self> {
        let mut command = crate::workers::command(config, crate::workers::Worker::Computer, &[])?;
        command
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if config
            .local_desktop
            .as_ref()
            .is_some_and(|value| value.host_control)
        {
            for name in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| unavailable())?;
        let mut input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let mut output = BufReader::new(output);
        let local = config.local_desktop.as_ref();
        let config = json!({"workspace":directory.join("workspace"),"workspaceId":workspace,
            "publicOrigin":origin,"hostControl":local.is_some_and(|value| value.host_control),
            "desktopDriver":local.and_then(|value| value.desktop_driver.as_ref())});
        let startup = async {
            input.write_all(config.to_string().as_bytes()).await?;
            input.write_all(b"\n").await?;
            input.flush().await?;
            let mut bytes = Vec::new();
            loop {
                let chunk = output.fill_buf().await?;
                if chunk.is_empty() {
                    return Err(unavailable());
                }
                let length = chunk
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|n| n + 1)
                    .unwrap_or(chunk.len());
                if bytes.len() + length > 16384 {
                    return Err(unavailable());
                }
                bytes.extend_from_slice(&chunk[..length]);
                output.consume(length);
                if bytes.last() == Some(&b'\n') {
                    break;
                }
            }
            let ready: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
            let url = ready["url"].as_str().ok_or_else(unavailable)?.to_owned();
            let token = ready["token"].as_str().ok_or_else(unavailable)?.to_owned();
            if ready["ready"] != true || !url.starts_with("http://127.0.0.1:") {
                return Err(unavailable());
            }
            super::model::worker_url(&url)?;
            super::model::validate_token(&token)?;
            Ok::<_, ApiError>((url, token))
        };
        let started = tokio::time::timeout(Duration::from_secs(15), startup).await;
        let (url, token) = match started {
            Ok(Ok(v)) => v,
            _ => {
                terminate(&mut child).await;
                return Err(unavailable());
            }
        };
        let (stop, mut stopping) = watch::channel(false);
        let (finished, done) = watch::channel(None);
        tokio::spawn(async move {
            let natural =
                tokio::select! {status=child.wait()=>Some(status),_=stopping.changed()=>None};
            let clean = if let Some(result) = natural {
                result.is_ok_and(|status| status.success())
            } else {
                let _ = input.write_all(b"close\n").await;
                let _ = input.flush().await;
                drop(input);
                match tokio::time::timeout(Duration::from_secs(60), child.wait()).await {
                    Ok(Ok(status)) => status.success(),
                    _ => {
                        terminate(&mut child).await;
                        false
                    }
                }
            };
            finished.send_replace(Some(clean));
            drop(output);
        });
        Ok(Self {
            url,
            token,
            stop,
            done,
        })
    }
    pub async fn close(&mut self) -> Result<()> {
        self.stop.send_replace(true);
        loop {
            let result = *self.done.borrow_and_update();
            if let Some(clean) = result {
                return if clean {
                    Ok(())
                } else {
                    Err(super::model::blocked())
                };
            }
            self.done
                .changed()
                .await
                .map_err(|_| super::model::blocked())?;
        }
    }
}
impl Drop for LocalExecutor {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}
async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        unsafe {
            libc::kill(-(id as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}
fn unavailable() -> ApiError {
    ApiError::new(503, "本机执行适配器暂不可用，需要 Node.js 22 或更新版本。")
}
