use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_START_BYTES: usize = 2 * 1024 * 1024;
const MAX_SYSTEM_UTF16: usize = 128_000;
const MAX_PROMPT_UTF16: usize = 256_000;

fn start_fits(value: &Value, bytes: usize) -> bool {
    // Match the Pi worker's JavaScript string and serialized frame limits.
    bytes <= MAX_START_BYTES
        && [
            ("systemPrompt", MAX_SYSTEM_UTF16),
            ("prompt", MAX_PROMPT_UTF16),
        ]
        .into_iter()
        .all(|(field, limit)| {
            value[field].as_str().is_some_and(|text| {
                !text.contains('\0') && text.encode_utf16().take(limit + 1).count() <= limit
            })
        })
}

fn context_too_large() -> ApiError {
    ApiError::new(413, "执行上下文过大。")
}

pub(super) fn serialize_run_prompt(prompt: &mut Value) -> Result<String> {
    let available = prompt["history"].as_array().map_or(0, Vec::len);
    for omitted in 0..=available {
        if omitted > 0 {
            prompt["history"].as_array_mut().unwrap().remove(0);
            prompt["historyWindow"] = json!({
                "omittedOlderEntries": omitted,
                "reason": "prompt_size_limit"
            });
        }
        let serialized = prompt.to_string();
        if serialized.encode_utf16().take(MAX_PROMPT_UTF16 + 1).count() <= MAX_PROMPT_UTF16 {
            return Ok(serialized);
        }
    }
    Err(context_too_large())
}

pub(crate) struct PiProcess {
    pub child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    frame: Vec<u8>,
}
impl PiProcess {
    pub async fn spawn(state: &crate::db::State) -> Result<Self> {
        let mut child = crate::workers::command(&state.config, crate::workers::Worker::Pi, &[])?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ApiError::new(503, "Pi 执行进程暂不可用。"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| ApiError::new(503, "Pi 执行通道不可用。"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| ApiError::new(503, "Pi 结果通道不可用。"))?,
        );
        Ok(Self {
            child,
            input,
            output,
            frame: Vec::new(),
        })
    }
    pub async fn send(&mut self, value: &Value) -> Result<()> {
        let mut bytes =
            serde_json::to_vec(value).map_err(|_| ApiError::bad("执行请求格式无效。"))?;
        if bytes.len() > MAX_FRAME || (value["type"] == "start" && !start_fits(value, bytes.len()))
        {
            return Err(context_too_large());
        }
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }
    pub async fn read(&mut self) -> Result<Option<Value>> {
        // Keep partial bytes in the process across select cancellation; cap before allocating a full line.
        let remaining = MAX_FRAME + 1 - self.frame.len();
        let read = (&mut self.output)
            .take(remaining as u64)
            .read_until(b'\n', &mut self.frame)
            .await?;
        if self.frame.len() > MAX_FRAME {
            return Err(ApiError::new(502, "Pi 结果超过允许大小。"));
        }
        if read == 0 && self.frame.is_empty() {
            return Ok(None);
        }
        if self.frame.last() != Some(&b'\n') {
            return Err(ApiError::new(502, "Pi 结果帧不完整。"));
        }
        let line = std::mem::take(&mut self.frame);
        serde_json::from_slice(&line)
            .map(Some)
            .map_err(|_| ApiError::new(502, "Pi 结果格式无效。"))
    }
    pub async fn stop(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_matches_worker_units_and_wire_size() {
        let mut value = json!({"systemPrompt":"🌿".repeat(MAX_SYSTEM_UTF16 / 2),"prompt":"task"});
        assert!(start_fits(&value, MAX_START_BYTES));
        assert!(!start_fits(&value, MAX_START_BYTES + 1));
        value["systemPrompt"] = json!("🌿".repeat(MAX_SYSTEM_UTF16 / 2 + 1));
        assert!(!start_fits(&value, MAX_START_BYTES));
        value["systemPrompt"] = json!("small");
        value["prompt"] = json!("x".repeat(MAX_PROMPT_UTF16 + 1));
        assert!(!start_fits(&value, MAX_START_BYTES));
    }

    #[test]
    fn oversized_history_drops_only_oldest_entries() {
        let mut prompt = json!({
            "content":"current human request", "replyContext":{"content":"reply"},
            "originalRequest":{"content":"structured original"}, "webhookEvent":{"source":"fixture"},
            "history":(0..18).map(|index| json!({"content":"🌿".repeat(15000),"index":index})).collect::<Vec<_>>()
        });
        let original = prompt.clone();
        let serialized = serialize_run_prompt(&mut prompt).unwrap();
        let bounded: Value = serde_json::from_str(&serialized).unwrap();
        let omitted = bounded["historyWindow"]["omittedOlderEntries"]
            .as_u64()
            .unwrap() as usize;
        assert!(omitted > 0 && omitted < 18);
        assert_eq!(
            bounded["history"].as_array().unwrap(),
            &original["history"].as_array().unwrap()[omitted..]
        );
        for field in ["content", "replyContext", "originalRequest", "webhookEvent"] {
            assert_eq!(bounded[field], original[field]);
        }
        assert!(serialized.encode_utf16().count() <= MAX_PROMPT_UTF16);
        let mut small = json!({"content":"current", "history":[{"content":"older"}]});
        assert_eq!(serialize_run_prompt(&mut small).unwrap(), small.to_string());
        assert!(small.get("historyWindow").is_none());
    }
}

pub(crate) fn workspace_directory(root: &Path) -> Result<PathBuf> {
    let path = root.join("workspace");
    if path.exists() && !std::fs::symlink_metadata(&path)?.is_dir() {
        return Err(ApiError::bad("工作目录不可用。"));
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&path)?;
    Ok(path)
}
