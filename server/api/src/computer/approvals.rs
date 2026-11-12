use super::{
    action_store,
    controller::Controller,
    controls, frames, model, screen_bindings, transfers,
    transport::{Authority, Request, Target},
    validation,
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, watch};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionContext {
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_root_id: Option<String>,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub requester: Option<Value>,
}
pub struct Job {
    pub context: ActionContext,
    pub target: Arc<Target>,
    pub authorize: Authority,
    pub stopped: watch::Sender<bool>,
    pub finished: watch::Sender<bool>,
    decision: Mutex<()>,
}
pub async fn request(
    controller: &Arc<Controller>,
    input: &Value,
    context: ActionContext,
    authorize: Authority,
) -> Result<Value> {
    if let Some(agent) = context.agent_id.as_deref() {
        screen_bindings::prepare(controller, agent, authorize.clone()).await?;
    }
    let _guard = controller.management.lock().await;
    controller.active()?;
    authorize().await?;
    if let Some(cid) = &context.conversation_id {
        controller
            .store
            .get(Table::Conversations, cid)
            .await?
            .ok_or_else(|| ApiError::new(404, "会话已不可用。"))?;
    }
    if let Some(agent) = &context.agent_id {
        screen_bindings::require_agent(&controller.store, agent).await?;
    }
    if context
        .requester
        .as_ref()
        .is_some_and(|r| !r["userId"].as_str().is_some_and(model::opaque))
    {
        return Err(ApiError::bad("操作发起者无效。"));
    }
    let target =
        controls::target(controller, context.agent_id.as_deref(), authorize.clone()).await?;
    if let Some(expected) = input.get("expectedTargetRevision") {
        if !expected.as_str().is_some_and(model::uuid) {
            return Err(ApiError::bad("电脑连接版本无效。"));
        }
        if target.state().await["targetRevision"] != *expected {
            return Err(ApiError::new(409, "工作电脑已切换，请刷新后再提交操作。")
                .with_code("COMPUTER_TARGET_CHANGED"));
        }
    }
    target
        .request(Request::get("/health"), authorize.clone())
        .await?;
    let current = target.state().await;
    let mut payload = validation::action(input, current["desktop"]["kind"] == "virtual")?;
    let kind = payload["type"].as_str().unwrap().to_owned();
    if kind == "local_shell" && !target.saved.has("local-shell-v1") {
        return Err(ApiError::new(409, "此电脑未启用本机命令执行能力。"));
    }
    if matches!(
        kind.as_str(),
        "browser_tabs" | "browser_select_tab" | "browser_close_tab"
    ) && !target.saved.has("browser-tabs-v1")
    {
        return Err(ApiError::new(
            409,
            "此电脑尚不支持标签页管理，请先升级执行器。",
        ));
    }
    if kind == "remote_shell"
        && !target
            .saved
            .capabilities
            .iter()
            .any(|c| c == "isolated-shell-v1")
    {
        return Err(ApiError::new(409, "此电脑未提供隔离的远程命令执行能力。"));
    }
    if (kind.starts_with("browser_") || kind.starts_with("desktop_"))
        && !kind.starts_with(&format!(
            "{}_",
            current["surface"].as_str().unwrap_or("browser")
        ))
    {
        return Err(ApiError::new(
            409,
            "此操作不属于当前电脑界面，请在电脑面板切换。",
        ));
    }
    transfers::inspect(&controller.store, &mut payload).await?;
    let jobs = controller
        .jobs
        .lock()
        .await
        .values()
        .filter(|j| !*j.finished.borrow())
        .count();
    if jobs >= 500 {
        return Err(ApiError::new(429, "待处理电脑操作过多。"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut action =
        json!({"id":id,"type":kind,"payload":payload,"status":"pending","createdAt":iso(now())});
    if let Some(agent) = &context.agent_id {
        action["agentId"] = json!(agent);
    }
    if let Some(requester) = &context.requester {
        action["requester"] = requester.clone();
    }
    if let Some(binding) = &target.binding {
        action["screenBinding"] =
            json!({"screenId":binding.screen_id,"assignmentRevision":binding.assignment_revision});
    }
    if kind.starts_with("desktop_") {
        action["desktopSession"] = current["desktop"]["session"].clone();
    }
    let recovery_scope = if controller.uses_shared_screen().await {
        "default"
    } else {
        context.agent_id.as_deref().unwrap_or("default")
    };
    let saved = json!({"id":id,"action":action,"context":context,"recoveryScope":recovery_scope,
        "cardId":uuid::Uuid::new_v4().to_string()});
    authorize().await?;
    action_store::persist(&controller.store, &saved).await?;
    let (stopped, _) = watch::channel(false);
    let (finished, _) = watch::channel(false);
    let job = Arc::new(Job {
        context,
        target,
        authorize,
        stopped,
        finished,
        decision: Mutex::new(()),
    });
    controller.jobs.lock().await.insert(id.clone(), job.clone());
    drop(_guard);
    if validation::readonly(&kind) {
        if let Err(error) = start(controller, &id, job.clone(), None).await {
            cancel(controller, &id, "电脑操作未能开始，请检查当前画面。").await?;
            return Err(error);
        }
        wait(controller, &id, job.authorize.clone()).await
    } else {
        let controller = controller.clone();
        let action_id = id.clone();
        tokio::spawn(async move {
            monitor(controller, action_id, job).await;
        });
        Ok(action)
    }
}
async fn monitor(controller: Arc<Controller>, id: String, job: Arc<Job>) {
    let until = now() + 600_000;
    while !*job.finished.borrow() {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if *job.stopped.borrow()
            || controller.active().is_err()
            || (job.authorize)().await.is_err()
            || now() > until
        {
            let _ = cancel(&controller, &id, "原任务权限已变化、已取消或审批已过期。").await;
            break;
        }
    }
}
pub async fn decide(
    state: &State,
    controller: &Arc<Controller>,
    id: &str,
    approve: bool,
    actor: &WorkspaceAccess,
) -> Result<Value> {
    actor.authorize(state).await?;
    let saved = action_store::raw(&controller.store, id).await?;
    if let Some(requester) = saved["action"].get("requester") {
        if requester["userId"].as_str() != Some(actor.user_id.as_str()) {
            return Err(ApiError::new(
                403,
                "只有发起本次任务的成员可以处理这项审批。",
            ));
        }
    } else {
        actor.authorize_owner(state).await?;
    }
    let job = controller
        .jobs
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| ApiError::new(409, "这项审批已失效。"))?;
    if !approve {
        let _guard = job.decision.lock().await;
        let mut current = action_store::raw(&controller.store, id).await?;
        if current["action"]["status"] != "pending" {
            return Err(ApiError::new(409, "此电脑操作已经处理或取消。"));
        }
        job.stopped.send_replace(true);
        current["action"]["status"] = json!("rejected");
        current["action"]["error"] = json!("用户已拒绝此电脑操作。");
        action_store::persist(&controller.store, &current).await?;
        job.finished.send_replace(true);
        super::job_retirement::completed(controller, id, &job).await;
        return Ok(current["action"].clone());
    }
    let owner_required = saved["action"].get("requester").is_none();
    let state = state.clone();
    let actor = actor.clone();
    let authority: Authority = Arc::new(move || {
        let state = state.clone();
        let actor = actor.clone();
        Box::pin(async move {
            if owner_required {
                actor.authorize_owner(&state).await
            } else {
                actor.authorize(&state).await
            }
        })
    });
    start(controller, id, job, Some(authority)).await?;
    action_store::get(&controller.store, id).await
}
async fn start(
    controller: &Arc<Controller>,
    id: &str,
    job: Arc<Job>,
    decision: Option<Authority>,
) -> Result<()> {
    let _guard = job.decision.lock().await;
    let mut saved = action_store::raw(&controller.store, id).await?;
    (job.authorize)().await?;
    job.target.active()?;
    if *job.stopped.borrow() || saved["action"]["status"] != "pending" {
        return Err(ApiError::new(409, "此电脑操作已经处理或取消。"));
    }
    if let Some(authorize) = &decision {
        authorize().await?;
    }
    if controls::takeover_status(
        controller,
        job.context.agent_id.as_deref(),
        job.authorize.clone(),
    )
    .await?["active"]
        != false
    {
        return Err(ApiError::new(409, "请先结束人工接管，再批准 Bot 操作。"));
    }
    saved["action"]["status"] = json!("running");
    action_store::persist(&controller.store, &saved).await?;
    let controller = controller.clone();
    let id = id.to_owned();
    let executing = job.clone();
    tokio::spawn(async move {
        let result = execute(&controller, &executing, &saved["action"], decision).await;
        let mut latest = action_store::raw(&controller.store, &id)
            .await
            .unwrap_or(saved);
        if !*executing.stopped.borrow() {
            match result {
                Ok(value) => {
                    latest["action"]["status"] = json!("done");
                    latest["action"]["result"] = value["result"].clone();
                    for key in ["frame", "frameUnavailable"] {
                        if let Some(value) = value.get(key) {
                            latest["action"][key] = value.clone();
                        }
                    }
                }
                Err(error) => {
                    latest["action"]["status"] = json!("error");
                    latest["action"]["error"] = json!(error.message);
                }
            }
        }
        if executing.target.is_blocked() {
            latest["recoveryRequired"] = json!(true);
            controller.tasks.block(
                latest["recoveryScope"]
                    .as_str()
                    .unwrap_or_else(|| executing.context.agent_id.as_deref().unwrap_or("default")),
            );
        }
        let _ = action_store::persist(&controller.store, &latest).await;
        executing.finished.send_replace(true);
        super::job_retirement::completed(&controller, &id, &executing).await;
    });
    Ok(())
}
fn authority(job: &Arc<Job>, decision: Option<Authority>) -> Authority {
    let job = job.clone();
    Arc::new(move || {
        let job = job.clone();
        let decision = decision.clone();
        Box::pin(async move {
            if *job.stopped.borrow() {
                return Err(ApiError::new(
                    409,
                    "电脑操作已取消，已经发生的效果不会回滚。",
                ));
            }
            (job.authorize)().await?;
            if let Some(check) = decision {
                check().await?;
            }
            Ok(())
        })
    })
}
async fn execute(
    controller: &Arc<Controller>,
    job: &Arc<Job>,
    action: &Value,
    decision: Option<Authority>,
) -> Result<Value> {
    let authorize = authority(job, decision);
    authorize().await?;
    let kind = action["type"].as_str().unwrap_or("");
    if matches!(kind, "upload_file" | "download_file") {
        return Ok(
            json!({"result":transfers::execute(&controller.store,&job.target,&action["payload"],job.context.conversation_id.as_deref(),job.context.agent_id.as_deref(),authorize).await?}),
        );
    }
    let with_frame = validation::frame_action(kind)
        && job.context.conversation_id.is_some()
        && job.context.agent_id.is_some()
        && job
            .target
            .saved
            .capabilities
            .iter()
            .any(|c| c == "action-frames");
    let mut request = Request::post(
        if with_frame {
            "/execute-with-frame"
        } else {
            "/execute"
        },
        &action["payload"],
    );
    if matches!(kind, "remote_shell" | "local_shell") {
        request.shell_id = action["id"].as_str().map(str::to_owned);
    }
    let value = job
        .target
        .request(request, authorize.clone())
        .await?
        .json()?;
    authorize().await?;
    if matches!(kind, "remote_shell" | "local_shell") {
        super::validation::shell_result(&value)?;
    }
    if !with_frame {
        return Ok(json!({"result":value}));
    }
    if value.get("result").is_none() {
        return Err(model::invalid());
    }
    let mut result = json!({"result":value["result"]});
    if let Some(frame) = value.get("frame") {
        match frames::save(
            &controller.store,
            &job.target,
            frame,
            job.context.conversation_id.as_deref().unwrap(),
            job.context.agent_id.as_deref().unwrap(),
            authorize.clone(),
        )
        .await
        {
            Ok(frame) => result["frame"] = frame,
            Err(_) => result["frameUnavailable"] = json!("操作已完成，但当时画面未能保存。"),
        }
    } else {
        result["frameUnavailable"] = json!("操作已完成，但当时画面未能保存。");
    }
    authorize().await?;
    Ok(result)
}
pub async fn cancel(controller: &Arc<Controller>, id: &str, reason: &str) -> Result<()> {
    let Some(job) = controller.jobs.lock().await.get(id).cloned() else {
        return Ok(());
    };
    job.stopped.send_replace(true);
    let _guard = job.decision.lock().await;
    let mut saved = action_store::raw(&controller.store, id).await?;
    let pending = saved["action"]["status"] == "pending";
    if pending || saved["action"]["status"] == "running" {
        saved["action"]["status"] = json!(if pending { "rejected" } else { "error" });
        saved["action"]["error"] = json!(reason);
        if pending {
            job.finished.send_replace(true);
        }
        action_store::persist(&controller.store, &saved).await?;
    }
    if pending {
        job.finished.send_replace(true);
        super::job_retirement::completed(controller, id, &job).await;
    }
    Ok(())
}
pub async fn cancel_scope(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    reason: &str,
) -> Result<()> {
    let jobs: Vec<_> = controller
        .jobs
        .lock()
        .await
        .iter()
        .filter(|(_, j)| agent.is_none_or(|a| j.context.agent_id.as_deref() == Some(a)))
        .map(|(id, j)| (id.clone(), j.clone()))
        .collect();
    let mut failure = None;
    for (id, _) in &jobs {
        if let Err(error) = cancel(controller, id, reason).await {
            failure = Some(error);
        }
    }
    for (_, job) in jobs {
        let mut done = job.finished.subscribe();
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                failure = Some(model::blocked());
                break;
            }
        }
        if job.target.is_blocked() {
            failure = Some(model::blocked());
        }
    }
    failure.map_or(Ok(()), Err)
}
pub async fn wait(controller: &Arc<Controller>, id: &str, authorize: Authority) -> Result<Value> {
    let job = controller.jobs.lock().await.get(id).cloned();
    if let Some(job) = job {
        let mut done = job.finished.subscribe();
        while !*done.borrow_and_update() {
            tokio::select! {_=done.changed()=>{},_=tokio::time::sleep(Duration::from_millis(200))=>{if authorize().await.is_err(){cancel(controller,id,"原任务已取消；已发生的操作不会回滚。").await?;}}}
        }
    }
    authorize().await?;
    action_store::get(&controller.store, id).await
}
