use super::{
    authority::ExecutionAccess,
    process::AgentProcess,
    queue,
    registry::{ActiveRun, AgentRegistry},
};
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use serde_json::json;
use std::sync::atomic::Ordering;

pub(crate) async fn inject(
    state: &State,
    grant: &ExecutionAccess,
    store: &WorkspaceStore,
    active: &ActiveRun,
    process: &mut AgentProcess,
) -> Result<()> {
    if !(active.kind == "user" || (active.kind == "routine" && !active.background))
        || active.cancelled.load(Ordering::Acquire)
    {
        return Ok(());
    }
    let key = AgentRegistry::key(grant.workspace_id(), &active.conversation_id);
    for input in state.agent_runs.queues.injection(&key, active).await {
        if input.access.authorize(state).await.is_err() {
            state
                .agent_runs
                .queues
                .delivered(&key, input.message["id"].as_str().unwrap_or(""))
                .await;
            queue::mark(
                store,
                &input.message,
                "interrupted",
                "补充消息的原账户权限已失效。",
            )
            .await?;
            continue;
        }
        grant.authorize(state).await?;
        let text=json!({"inputId":input.message["id"],"requester":input.access.requester(input.message["id"].as_str().unwrap_or("")),"content":input.message["content"],"replyContext":input.message["replyTo"]}).to_string();
        process.send(&json!({"type":if input.message["delivery"]["mode"]=="steer" {"steer"}else{"follow_up"},"runId":active.run_id,"inputId":input.message["id"],"text":text})).await?;
    }
    Ok(())
}
pub(crate) async fn delivered(
    state: &State,
    grant: &ExecutionAccess,
    store: &WorkspaceStore,
    active: &ActiveRun,
    input_id: &str,
) -> Result<Option<u64>> {
    let key = AgentRegistry::key(grant.workspace_id(), &active.conversation_id);
    let Some(pending) = state.agent_runs.queues.delivered(&key, input_id).await else {
        return Err(ApiError::new(502, "执行进程返回了未知补充消息。"));
    };
    pending.access.authorize(state).await?;
    grant.authorize(state).await?;
    let mut tx = store.begin().await?;
    let mut input = WorkspaceStore::get_in(&mut tx, Table::Messages, input_id)
        .await?
        .ok_or_else(|| ApiError::new(409, "补充消息已不存在。"))?;
    if input["delivery"]["state"] != "queued"
        || input["userId"] != active.user_id
        || input["delivery"]["agentId"] != active.agent_id
    {
        return Err(ApiError::new(409, "补充消息的收件人已改变。"));
    }
    input["delivery"]["state"] = json!("delivered");
    input["delivery"]["runId"] = json!(active.run_id);
    WorkspaceStore::put_in(&mut tx, Table::Messages, &input).await?;
    pending.access.authorize(state).await?;
    grant.authorize(state).await?;
    tx.commit().await?;
    store.emit("message", input);
    Ok(pending.generation)
}
