use super::runtime::Authority;
use crate::{
    db::State,
    error::{ApiError, Result},
};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Child,
};
const MAX: usize = 2 * 1024 * 1024;

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
/// Every external dispatch is authorized by the Rust parent immediately beforehand.
/// There is no retry: loss of a tool response is always an unknown external outcome.
pub async fn run(state: &State, request: Value, authorize: Authority) -> Result<Value> {
    let state = state.clone();
    let (mut sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let result = run_process(&state, request, authorize, &mut sender).await;
        let _ = sender.send(result);
    });
    receiver
        .await
        .map_err(|_| ApiError::new(502, "应用执行结果未确认。"))?
}
async fn run_process(
    state: &State,
    mut request: Value,
    authorize: Authority,
    sender: &mut tokio::sync::oneshot::Sender<Result<Value>>,
) -> Result<Value> {
    let _slot = state
        .apps
        .slots
        .try_acquire()
        .map_err(|_| ApiError::new(429, "应用请求过多，请稍后重试。"))?;
    let _lease = state.apps.enter()?;
    authorize().await?;
    request["type"] = json!("operation");
    request["testOrigins"] = json!(state.apps.fixture_origins);
    request["publicOrigin"] = json!(state.config.public_origin);
    let bytes = serde_json::to_vec(&request).map_err(|_| ApiError::bad("应用请求无效。"))?;
    if bytes.len() > MAX {
        return Err(ApiError::new(413, "应用请求过大。"));
    }
    let mut command = crate::workers::command(&state.config, crate::workers::Worker::Mcp, &[])?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| ApiError::new(503, "应用协议执行器暂不可用。"))?;
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let task = async {
        input.write_all(&bytes).await?;
        input.write_all(b"\n").await?;
        input.flush().await?;
        let mut output = BufReader::new(output);
        let mut total = 0usize;
        loop {
            let mut line = Vec::new();
            loop {
                let available = output.fill_buf().await?;
                if available.is_empty() {
                    return Err(ApiError::new(502, "应用执行结果未确认。"));
                }
                let count = available
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|i| i + 1)
                    .unwrap_or(available.len());
                if total + count > MAX {
                    return Err(ApiError::new(502, "应用响应过大。"));
                }
                line.extend_from_slice(&available[..count]);
                output.consume(count);
                total += count;
                if line.last() == Some(&b'\n') {
                    break;
                }
            }
            let frame: Value = serde_json::from_slice(&line)
                .map_err(|_| ApiError::new(502, "应用响应格式无效。"))?;
            if frame["type"] == "authorize" {
                state.apps.active()?;
                authorize().await?;
                let answer = json!({"type":"authorization","id":frame["id"],"allowed":true});
                input.write_all(format!("{answer}\n").as_bytes()).await?;
                input.flush().await?;
            } else if frame["type"] == "result" {
                authorize().await?;
                if frame["ok"] == true {
                    return Ok(frame["result"].clone());
                }
                return Err(match frame["kind"].as_str() {
                    Some("auth") => {
                        ApiError::new(409, "应用需要重新授权。").with_code("APP_AUTH_REQUIRED")
                    }
                    Some("blocked") => {
                        ApiError::bad("应用地址不可访问，请使用公网 HTTPS 服务且不要设置跳转。")
                    }
                    _ => ApiError::new(502, "无法取得应用的确定结果，请检查服务状态。"),
                });
            } else {
                return Err(ApiError::new(502, "应用响应格式无效。"));
            }
        }
    };
    tokio::pin!(task);
    let deadline = tokio::time::sleep(Duration::from_secs(if request["op"] == "revoke" {
        5
    } else {
        48
    }));
    tokio::pin!(deadline);
    let mut timer = tokio::time::interval(Duration::from_millis(200));
    let result = loop {
        tokio::select! {
            value=&mut task=>break value,
            _=sender.closed()=>break Err(ApiError::new(409,"应用请求已取消。")),
            _=&mut deadline=>break Err(ApiError::new(504,"应用请求超时，结果未确认。")),
            _=timer.tick()=>{ if let Err(error)=state.apps.active() { break Err(error); } if let Err(error)=authorize().await { break Err(error); } }
        }
    };
    terminate(&mut child).await;
    result
}
