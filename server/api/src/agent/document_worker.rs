use crate::{
    apps::Authority,
    db::State,
    error::{ApiError, Result},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Semaphore, oneshot},
};

const INPUT_LIMIT: usize = 10 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 12 * 1024 * 1024;
static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
fn unavailable() -> ApiError {
    ApiError::new(422, "附件解析失败，文件可能损坏、不受支持或超过限制。")
}

pub(crate) async fn parse(
    state: &State,
    name: String,
    bytes: Vec<u8>,
    authorize: Authority,
) -> Result<Value> {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(ApiError::new(413, "附件为空或超过 10 MiB。"));
    }
    authorize().await?;
    let permit = SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(429, "正在解析其它附件，请稍后重试（同时最多 2 个）。"))?;
    let state = state.clone();
    let (sender, receiver) = oneshot::channel();
    // The supervisor outlives a dropped HTTP/tool future and releases its slot only after wait.
    let worker_authorize = authorize.clone();
    tokio::spawn(async move {
        supervise(state, name, bytes, worker_authorize, sender, permit).await;
    });
    let value = receiver.await.map_err(|_| unavailable())??;
    authorize().await?;
    Ok(value)
}
async fn supervise(
    state: State,
    name: String,
    bytes: Vec<u8>,
    authorize: Authority,
    mut sender: oneshot::Sender<Result<Value>>,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    let original_size = bytes.len();
    let input = json!({"version":1,"name":name,"data":STANDARD.encode(bytes)}).to_string();
    let mut command = match crate::workers::command(
        &state.config,
        crate::workers::Worker::Document,
        &["--max-old-space-size=192"],
    ) {
        Ok(command) => command,
        Err(error) => {
            let _ = sender.send(Err(error));
            return;
        }
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    if let Err(error) = authorize().await {
        let _ = sender.send(Err(error));
        return;
    }
    if sender.is_closed() {
        return;
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            let _ = sender.send(Err(ApiError::new(503, "无法启动附件解析进程。")));
            return;
        }
    };
    let pid = child.id();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let writer = tokio::spawn(async move {
        stdin.write_all(input.as_bytes()).await?;
        stdin.shutdown().await
    });
    let mut reader = tokio::spawn(async move {
        let mut output = Vec::new();
        stdout
            .take(OUTPUT_LIMIT as u64 + 1)
            .read_to_end(&mut output)
            .await?;
        Ok::<_, std::io::Error>(output)
    });
    let deadline = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(deadline);
    let mut watch = tokio::time::interval(Duration::from_millis(100));
    let outcome = 'running: loop {
        tokio::select! {
            biased;
            _=sender.closed()=>break Err(ApiError::new(409,"附件读取已取消。")),
            _=&mut deadline=>break Err(ApiError::new(422,"附件解析超时，请缩小文件或拆分后重试。")),
            _=watch.tick()=>tokio::select! {
                biased;
                _=sender.closed()=>break 'running Err(ApiError::new(409,"附件读取已取消。")),
                _=&mut deadline=>break 'running Err(ApiError::new(422,"附件解析超时，请缩小文件或拆分后重试。")),
                result=authorize()=>if let Err(error)=result {break 'running Err(error)},
            },
            output=&mut reader=>break match output {
                Ok(Ok(output)) if output.len()<=OUTPUT_LIMIT=>serde_json::from_slice::<Value>(&output).map_err(|_|unavailable()),
                _=>Err(unavailable()),
            },
        }
    };
    // Terminate the whole disposable process group, then reap before returning or freeing capacity.
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    let waited = child.wait().await;
    writer.abort();
    let _ = writer.await;
    if !reader.is_finished() {
        reader.abort();
        let _ = reader.await;
    }
    let result = match outcome {
        Ok(value) if waited.is_ok() => validate(value, &name, original_size),
        Ok(_) => Err(unavailable()),
        Err(error) => Err(error),
    };
    drop(permit);
    let _ = sender.send(result);
}
fn validate(value: Value, name: &str, size: usize) -> Result<Value> {
    if value["version"] != 1 || value["ok"] != true {
        return Err(unavailable());
    }
    let result = value["result"].clone();
    if result["name"] != name
        || result["byteLength"].as_u64() != Some(size as u64)
        || !result["truncated"].is_boolean()
        || !result["warnings"].as_array().is_some_and(|warnings| {
            warnings.len() <= 10
                && warnings
                    .iter()
                    .all(|v| v.as_str().is_some_and(|s| s.len() <= 2000))
        })
    {
        return Err(unavailable());
    }
    match result["kind"].as_str() {
        Some("text")
            if result["text"]
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 120_000) => {}
        Some("image") => {
            let data = result["data"].as_str().ok_or_else(unavailable)?;
            let bytes = STANDARD.decode(data).map_err(|_| unavailable())?;
            if result["mimeType"] != "image/png"
                || bytes.len() > 8 * 1024 * 1024
                || bytes.len() < 24
                || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
            {
                return Err(unavailable());
            }
            let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
            if width == 0
                || height == 0
                || width > 2048
                || height > 2048
                || result["width"].as_u64() != Some(width as u64)
                || result["height"].as_u64() != Some(height as u64)
            {
                return Err(unavailable());
            }
        }
        _ => return Err(unavailable()),
    }
    Ok(result)
}

#[cfg(test)]
#[path = "document_worker_tests.rs"]
mod tests;
