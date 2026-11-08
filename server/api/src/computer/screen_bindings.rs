use super::{
    controller::Controller,
    model::{self, DesktopSession, ScreenBinding},
    private_config,
    transport::{Authority, Request, Target},
};
use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub agent_id: String,
    pub kind: String,
    pub binding: ScreenBinding,
    pub next_assignment_revision: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub version: u8,
    pub workspace_scope_id: String,
    pub bindings: Vec<ScreenBinding>,
    #[serde(default)]
    pub operations: Vec<Operation>,
}
pub fn load(store: &WorkspaceStore) -> Result<Journal> {
    let Some(bytes) = private_config::read_private(
        &store.directory.join("computer/bot-screens.json"),
        4 * 1024 * 1024,
    )?
    else {
        return Ok(Journal {
            version: 2,
            workspace_scope_id: store.workspace_id.clone(),
            bindings: vec![],
            operations: vec![],
        });
    };
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| model::invalid())?;
    if ![1, 2].contains(&journal.version)
        || journal.workspace_scope_id != store.workspace_id
        || journal.bindings.len() > 2
        || journal.operations.len() > 2000
    {
        return Err(model::invalid());
    }
    let mut screens = std::collections::HashSet::new();
    let mut agents = std::collections::HashSet::new();
    for binding in &journal.bindings {
        binding.validate()?;
        if !screens.insert(&binding.screen_id) || !agents.insert(&binding.agent_id) {
            return Err(model::invalid());
        }
    }
    let mut ids = std::collections::HashSet::new();
    for operation in &journal.operations {
        operation.binding.validate()?;
        if !model::uuid(&operation.operation_id)
            || !ids.insert(&operation.operation_id)
            || !model::uuid(&operation.next_assignment_revision)
            || operation.agent_id != operation.binding.agent_id
            || !["release", "reset"].contains(&operation.kind.as_str())
            || !["pending", "blocked", "complete"].contains(&operation.status.as_str())
        {
            return Err(model::invalid());
        }
    }
    Ok(journal)
}
pub fn save(store: &WorkspaceStore, journal: &Journal) -> Result<()> {
    let bytes = serde_json::to_vec(journal).map_err(|_| model::invalid())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(ApiError::new(409, "画面维护记录已满，请联系维护人员。"));
    }
    private_config::atomic_private(&store.directory.join("computer/bot-screens.json"), &bytes)
}
pub async fn inventory(controller: &Arc<Controller>, authorize: Authority) -> Result<Value> {
    let target = controller.target(authorize.clone()).await?;
    if !target
        .saved
        .capabilities
        .iter()
        .any(|c| c == model::SCREEN_POOL)
    {
        return Err(ApiError::new(409, "尚未配置 Bot 独立画面。"));
    }
    let value = target
        .request(Request::get("/screens"), authorize)
        .await?
        .json()?;
    let screens = value["screens"].as_array().ok_or_else(model::invalid)?;
    if value["protocol"] != "openbot-screen-pool-v1"
        || value["instanceId"] != target.saved.instance_id
        || value["workspaceScopeId"] != controller.store.workspace_id
        || value["capacity"]["max"] != 2
        || screens.len() > 2
        || value["capacity"]["configured"].as_u64() != Some(screens.len() as u64)
    {
        return Err(model::invalid());
    }
    let mut ids = std::collections::HashSet::new();
    for screen in screens {
        let id = screen["id"]
            .as_str()
            .filter(|s| model::uuid(s))
            .ok_or_else(model::invalid)?;
        DesktopSession::parse(&screen["session"])?;
        if !ids.insert(id)
            || screen
                .get("revision")
                .is_some_and(|r| !r.as_str().is_some_and(model::uuid))
        {
            return Err(model::invalid());
        }
    }
    Ok(value)
}
pub async fn prepare(
    controller: &Arc<Controller>,
    agent: &str,
    authorize: Authority,
) -> Result<Value> {
    let _guard = controller.management.lock().await;
    require_agent(&controller.store, agent).await?;
    authorize().await?;
    controller.active()?;
    if controller.is_local().await {
        return status(controller, agent, authorize).await;
    }
    let existing = controller
        .bindings
        .lock()
        .await
        .bindings
        .iter()
        .find(|b| b.agent_id == agent)
        .cloned();
    if existing.is_some() {
        return status(controller, agent, authorize).await;
    }
    let inventory = inventory(controller, authorize.clone()).await?;
    let mut journal = controller.bindings.lock().await.clone();
    let screen = inventory["screens"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| {
            s["available"] == true
                && !journal.bindings.iter().any(|b| s["id"] == b.screen_id)
                && s["lifecycle"]["state"] != "blocked"
                && s["lifecycle"]["state"] != "changing"
        })
        .ok_or_else(|| ApiError::new(409, "独立画面名额已用完，请先释放不再使用的画面。"))?;
    let binding = ScreenBinding {
        agent_id: agent.into(),
        screen_id: screen["id"].as_str().unwrap().into(),
        assignment_revision: uuid::Uuid::new_v4().to_string(),
        session: DesktopSession::parse(&screen["session"])?,
        screen_revision: screen["revision"].as_str().map(str::to_owned),
    };
    authorize().await?;
    require_agent(&controller.store, agent).await?;
    journal.bindings.push(binding);
    save(&controller.store, &journal)?;
    *controller.bindings.lock().await = journal;
    controller.changed();
    status(controller, agent, authorize).await
}
pub async fn target(
    controller: &Arc<Controller>,
    agent: &str,
    authorize: Authority,
    allow_prepare: bool,
) -> Result<Arc<Target>> {
    if controller.is_local().await {
        require_agent(&controller.store, agent).await?;
        authorize().await?;
        if controller.tasks.blocked(None) {
            return Err(model::blocked());
        }
        return controller.target(authorize).await;
    }
    if controller.tasks.blocked(Some(agent)) {
        return Err(model::blocked());
    }
    if allow_prepare {
        prepare(controller, agent, authorize.clone()).await?;
    }
    let journal = controller.bindings.lock().await.clone();
    let binding = journal
        .bindings
        .iter()
        .find(|b| b.agent_id == agent)
        .ok_or_else(|| ApiError::new(409, "请先准备此 Bot 的独立画面。"))?;
    if journal
        .operations
        .iter()
        .any(|o| o.agent_id == agent && o.status != "complete")
    {
        return Err(ApiError::new(409, "此画面正在维护，请继续处理原维护记录。"));
    }
    require_agent(&controller.store, agent).await?;
    controller.bound_target(binding, authorize).await
}
pub async fn status(
    controller: &Arc<Controller>,
    agent: &str,
    authorize: Authority,
) -> Result<Value> {
    require_agent(&controller.store, agent).await?;
    authorize().await?;
    if controller.is_local().await {
        let mut value = controller.refresh(authorize).await;
        value["botScreen"] = shared_screen(&value, agent, &controller.tasks.state("default"))?;
        return Ok(value);
    }
    let journal = controller.bindings.lock().await.clone();
    let binding = journal.bindings.iter().find(|b| b.agent_id == agent);
    let operation = journal
        .operations
        .iter()
        .find(|o| o.agent_id == agent && o.status != "complete");
    let mut value = controller.state().await;
    value["connected"] = json!(false);
    let mut screen = json!({"agentId":agent,"status":"unassigned","task":{"status":"idle","queued":0},
        "lifecycle":{"state":"ready","releaseAllowed":false,"resetAllowed":false}});
    if let Some(binding) = binding {
        screen["screenId"] = json!(binding.screen_id);
        screen["assignmentRevision"] = json!(binding.assignment_revision);
        let mut available = false;
        let mut cleanup_unknown = false;
        if operation.is_none() {
            match controller.bound_target(binding, authorize.clone()).await {
                Ok(target) => {
                    let refresh = target.request(Request::get("/health"), authorize).await;
                    cleanup_unknown = target.is_blocked();
                    let location = value["executionLocation"].clone();
                    value = target.state().await;
                    value["executionLocation"] = location;
                    available = refresh.is_ok() && value["connected"] == true;
                }
                Err(_) => {
                    screen["reason"] = json!("画面暂不可用，请检查连接。");
                }
            }
        }
        screen["status"] = json!(if available { "ready" } else { "unavailable" });
        let busy = controller.busy(Some(agent)).await;
        let task_blocked = controller.tasks.state(agent)["status"] == "blocked";
        screen["lifecycle"] = json!({"state":if operation.is_some(){"blocked"}else if cleanup_unknown{"blocked"}else{"ready"},
            "releaseAllowed":!busy && available && !task_blocked && operation.is_none(),
            "resetAllowed":!busy && (!available || task_blocked) && operation.is_none()});
        if let Some(operation) = operation {
            screen["lifecycle"]["state"] = json!(if operation.status == "pending" {
                "changing"
            } else {
                "blocked"
            });
            screen["lifecycle"]["operation"] =
                json!({"id":operation.operation_id,"kind":operation.kind});
            screen["lifecycle"]["reason"] = json!("请继续处理此画面的原维护记录。");
            screen["task"]["status"] = json!("maintenance");
        } else if cleanup_unknown {
            screen["task"]["status"] = json!("blocked");
        }
    } else {
        screen["reason"] = json!("尚未分配独立画面。请选择准备此 Bot 画面。");
    }
    let task = controller.tasks.state(agent);
    if task["status"] != "idle" || task["queued"] != 0 {
        screen["task"] = task;
    }
    value["botScreen"] = screen;
    Ok(value)
}
pub async fn list(controller: &Arc<Controller>, authorize: Authority) -> Result<Value> {
    if controller.is_local().await {
        // One health request and one task snapshot represent the shared browser,
        // regardless of how many Bot summaries this workspace contains.
        let state = controller.refresh(authorize.clone()).await;
        let task = controller.tasks.state("default");
        let mut bots = vec![];
        for agent in controller.store.list(Table::Agents).await? {
            if let Some(id) = agent["id"].as_str() {
                bots.push(shared_screen(&state, id, &task)?);
            }
        }
        authorize().await?;
        // Also reject a changed selection when there happen to be zero Bots.
        validate_shared_state(&state)?;
        return Ok(json!({"shared":true,"capacity":{"max":1,"configured":1,
            "ready":if state["connected"] == true {1}else{0},"assigned":0},"bots":bots,
            "reason":"所有 Bot 共用一个本机独立浏览器；任务按顺序执行。"}));
    }
    let inventory = inventory(controller, authorize.clone()).await;
    let assigned = controller.bindings.lock().await.bindings.len();
    let mut capacity = inventory
        .as_ref()
        .map(|v| v["capacity"].clone())
        .unwrap_or(json!({"max":0,"configured":0,"ready":0}));
    capacity["assigned"] = json!(assigned);
    let mut bots = vec![];
    for agent in controller.store.list(Table::Agents).await? {
        if let Some(id) = agent["id"].as_str() {
            bots.push(status(controller, id, authorize.clone()).await?["botScreen"].clone());
        }
    }
    let mut result = json!({"capacity":capacity,"bots":bots});
    if inventory.is_err() {
        result["reason"] = json!("尚未连接支持独立画面的电脑。");
    }
    Ok(result)
}
fn validate_shared_state(value: &Value) -> Result<()> {
    if value["mode"] != "local" || value["executionLocation"] != "server" {
        return Err(ApiError::new(409, "电脑连接已变化，请刷新后重试。"));
    }
    Ok(())
}
fn shared_screen(value: &Value, agent: &str, task: &Value) -> Result<Value> {
    validate_shared_state(value)?;
    Ok(json!({
        "agentId":agent,"shared":true,
        "status":if value["connected"] == true {"ready"} else {"unavailable"},
        "reason":"所有 Bot 共用一个本机独立浏览器；任务按顺序执行。",
        "task":task,
        "lifecycle":{"state":if task["status"] == "blocked" {"blocked"}else{"ready"},
            "releaseAllowed":false,"resetAllowed":false}
    }))
}
pub(crate) async fn require_agent(store: &WorkspaceStore, id: &str) -> Result<()> {
    if !model::opaque(id) || store.get(Table::Agents, id).await?.is_none() {
        return Err(ApiError::new(404, "Bot 不存在。"));
    }
    Ok(())
}
