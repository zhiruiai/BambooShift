use super::process::{AgentProcess, workspace_directory};
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::{WorkspaceAccess, model},
};
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::{Semaphore, watch};

static SLOTS: OnceLock<Semaphore> = OnceLock::new();
const MAX_CONTEXT: usize = 256 * 1024;
const MAX_RESULT: usize = 128 * 1024;

#[derive(Clone, Copy)]
enum CompletionPurpose {
    Planning,
    CreationPreview,
}

/// Run a scoped planning conversation with no tools or business database access.
pub async fn complete(
    state: &State,
    access: &WorkspaceAccess,
    system: &str,
    prompt: &str,
) -> Result<String> {
    let (keepalive, cancelled) = watch::channel(false);
    let result = complete_cancellable(state, access, system, prompt, cancelled).await;
    drop(keepalive);
    result
}

pub async fn complete_cancellable(
    state: &State,
    access: &WorkspaceAccess,
    system: &str,
    prompt: &str,
    cancelled: watch::Receiver<bool>,
) -> Result<String> {
    let store = access.store(state).await?;
    let profile = model::runtime_config(&store).await?;
    complete_profile_cancellable(state, access, &profile, system, prompt, cancelled).await
}

/// Use a server-resolved credential snapshot without changing the workspace default.
pub async fn complete_profile_cancellable(
    state: &State,
    access: &WorkspaceAccess,
    profile: &Value,
    system: &str,
    prompt: &str,
    cancelled: watch::Receiver<bool>,
) -> Result<String> {
    complete_with_profile(
        state,
        access,
        profile,
        system,
        prompt,
        cancelled,
        CompletionPurpose::Planning,
    )
    .await
}

pub(crate) async fn complete_creation_preview(
    state: &State,
    access: &WorkspaceAccess,
    system: &str,
    prompt: &str,
) -> Result<String> {
    access.authorize_owner(state).await?;
    let store = access.store(state).await?;
    let profile = model::runtime_config(&store).await?;
    let (keepalive, cancelled) = watch::channel(false);
    let result = complete_with_profile(
        state,
        access,
        &profile,
        system,
        prompt,
        cancelled,
        CompletionPurpose::CreationPreview,
    )
    .await;
    drop(keepalive);
    result
}

async fn complete_with_profile(
    state: &State,
    access: &WorkspaceAccess,
    profile: &Value,
    system: &str,
    prompt: &str,
    mut cancelled: watch::Receiver<bool>,
    purpose: CompletionPurpose,
) -> Result<String> {
    access.authorize(state).await?;
    if *cancelled.borrow() {
        return Err(ApiError::new(409, "规划已取消。"));
    }
    if system.len() + prompt.len() > MAX_CONTEXT {
        return Err(ApiError::new(413, "规划内容过大，请精简后重试。"));
    }
    let _slot = SLOTS
        .get_or_init(|| Semaphore::new(4))
        .try_acquire()
        .map_err(|_| ApiError::new(429, "规划任务较多，请稍后重试。"))?;
    let store = access.store(state).await?;
    if profile["configured"] != true {
        return Err(ApiError::bad("还没有连接模型服务，请先配置模型。"));
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let start = json!({"type":"start","version":1,"runId":run_id,"cwd":workspace_directory(&store.directory)?,"systemPrompt":system,"prompt":prompt,"profile":{"provider":profile["provider"],"model":profile["model"],"baseUrl":profile["baseUrl"],"apiKey":profile["apiKey"],"vision":false},"tools":[]});
    let mut process = AgentProcess::spawn(state).await?;
    let result = async {
        access.authorize(state).await?;
        tokio::select! {
            result = process.send(&start) => { result?; },
            _ = cancelled.changed() => { return Err(ApiError::new(409,"规划已取消。")); },
            _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => { return Err(ApiError::new(504,"规划进程未能启动。")); },
        }
        let mut security = state.subscribe_security();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        let deadline = tokio::time::sleep(Duration::from_secs(match purpose {
            CompletionPurpose::Planning => 180,
            CompletionPurpose::CreationPreview => 60,
        }));
        tokio::pin!(deadline);
        let mut output = String::new();
        loop {
            tokio::select! {
                event = process.read() => {
                    let event = event?.ok_or_else(|| ApiError::new(502, "规划进程已中断，请检查原请求。"))?;
                    access.authorize(state).await?;
                    if event["runId"] != run_id { return Err(ApiError::new(502,"规划结果身份不一致。")); }
                    match event["type"].as_str().unwrap_or("") {
                        "event" => {
                            if matches!(purpose, CompletionPurpose::Planning) && event["event"]["type"] == "message_end" && event["event"]["message"]["role"] == "assistant" {
                                let mut tx = store.begin().await?;
                                super::usage::record_snapshot(&mut tx, &run_id, "completion", &access.user_id, None, profile, &event["event"]["message"]["usage"]).await?;
                                access.authorize(state).await?;
                                if *cancelled.borrow() || cancelled.has_changed().is_err() { return Err(ApiError::new(409,"规划已取消。")); }
                                if state.is_closing() || store.is_closed() || state.agent_runs.is_closed() { return Err(ApiError::new(503,"服务正在停止。")); }
                                tx.commit().await?;
                            }
                            if let Some(text) = assistant_text(&event["event"]) { output = text; }
                            if output.len() > MAX_RESULT { return Err(ApiError::new(502,"规划结果过大，请精简要求后重试。")); }
                        },
                        "tool_call" => return Err(ApiError::new(403, "规划任务不能执行工具。")),
                        "settled" => {
                            if event["status"] != "completed" { return Err(ApiError::new(502,"规划未完成，请检查模型配置后重试。")); }
                            if output.trim().is_empty() { return Err(ApiError::new(502,"模型没有返回有效规划。")); }
                            access.authorize(state).await?;
                            return Ok(output);
                        },
                        _ => {},
                    }
                },
                _ = interval.tick() => {
                    access.authorize(state).await?;
                    if state.is_closing() || store.is_closed() || state.agent_runs.is_closed() { return Err(ApiError::new(503,"服务正在停止。")); }
                },
                _ = security.recv() => { access.authorize(state).await?; },
                _ = cancelled.changed() => { if *cancelled.borrow() || cancelled.has_changed().is_err() { return Err(ApiError::new(409,"规划已取消。")); } },
                _ = &mut deadline => return Err(ApiError::new(504,"规划超时，请检查原请求后重试。")),
            }
        }
    }.await;
    process.stop().await;
    result
}
pub(super) fn assistant_text(event: &Value) -> Option<String> {
    if !["message_start", "message_update", "message_end"]
        .contains(&event["type"].as_str().unwrap_or(""))
        || event["message"]["role"] != "assistant"
    {
        return None;
    }
    Some(
        event["message"]["content"]
            .as_array()?
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect(),
    )
}
