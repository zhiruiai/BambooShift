use super::{
    connections,
    interactive_policy::Candidate,
    interactive_rules as rules,
    model::{PreparedCall, UNKNOWN},
    runtime::Authority,
    store,
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Clone)]
pub struct ActionContext {
    pub conversation_id: String,
    pub thread_root_id: Option<String>,
    pub agent_id: String,
    pub run_id: String,
    pub requester: Option<Value>,
    pub source: Option<Value>,
}
pub(crate) struct Job {
    pub source: Arc<WorkspaceStore>,
    pub recipient: Arc<WorkspaceStore>,
    pub prepared: PreparedCall,
    pub authorize: Authority,
    pub stopped: watch::Sender<bool>,
    interactive: Option<(Candidate, String)>,
}
pub async fn request(
    state: &State,
    recipient: Arc<WorkspaceStore>,
    source: Arc<WorkspaceStore>,
    context: ActionContext,
    prepared: PreparedCall,
    authorize: Authority,
) -> Result<Value> {
    request_with_candidate(state, recipient, source, context, prepared, authorize, None).await
}

pub async fn request_with_candidate(
    state: &State,
    recipient: Arc<WorkspaceStore>,
    source: Arc<WorkspaceStore>,
    context: ActionContext,
    prepared: PreparedCall,
    authorize: Authority,
    candidate: Option<Candidate>,
) -> Result<Value> {
    state.apps.active()?;
    authorize().await?;
    let connection = state
        .apps
        .lock(&format!(
            "{}:{}",
            source.workspace_id, prepared.connection_id
        ))
        .await;
    let connection_guard = connection.lock().await;
    let current = connections::prepare_call(
        &source,
        &prepared.connection_id,
        &prepared.tool_name,
        &prepared.arguments,
    )
    .await?;
    if !current.matches(&prepared) {
        return Err(ApiError::new(409, "应用工具已变化，请重新确认。"));
    }
    let id = Uuid::new_v4().to_string();
    let (stopped, _) = watch::channel(false);
    let candidate =
        candidate.filter(|candidate| candidate.applies(&recipient, &source, &context, &prepared));
    let mut action = json!({"id":id,"conversationId":context.conversation_id,"agentId":context.agent_id,"connectionId":prepared.connection_id,"appName":prepared.app_name,"toolName":prepared.tool_name,"arguments":prepared.arguments,"status":"pending","createdAt":iso(now()),"expiresAt":iso(now()+300_000)});
    if let Some(requester) = context.requester {
        action["requester"] = requester;
    }
    if let Some(source) = context.source {
        action["source"] = source;
    }
    let mut saved = json!({"id":id,"action":action,"prepared":prepared,"runId":context.run_id,"sourceWorkspaceId":source.workspace_id,"cardId":Uuid::new_v4().to_string()});
    crate::agent::threads::stamp(&mut saved, context.thread_root_id.as_deref());
    authorize().await?;
    let mut tx = recipient.begin().await?;
    let mut auto = None;
    let mut interactive = None;
    if let Some(candidate) = candidate {
        candidate.actor.authorize_owner(state).await?;
        if let Some(prior) = candidate.used(&mut tx, &prepared).await? {
            drop(tx);
            return get(&recipient, &prior).await;
        }
        if let Some(scope) = candidate.inspect(&mut tx, &prepared).await? {
            candidate.use_action(&mut tx, &prepared, &id).await?;
            if let Some(rule_id) =
                rules::active_id(&mut tx, &candidate.actor.user_id, &scope.digest).await?
            {
                scope.mark(&mut saved, &rule_id, "reused", &candidate.actor.user_id);
                let approval =
                    candidate.authority(state, &recipient, &prepared, &scope.digest, &rule_id);
                auto = Some((approval, scope.restrict(prepared.clone())));
            } else {
                saved["action"]["interactiveApproval"] = scope.pending();
            }
            interactive = Some((candidate, scope.digest));
        }
    }
    let card = write_in(&mut tx, &saved).await?;
    state.apps.active()?;
    tx.commit().await?;
    let job = Arc::new(Job {
        source,
        recipient: recipient.clone(),
        prepared,
        authorize,
        stopped,
        interactive,
    });
    state.apps.jobs.lock().await.insert(id.clone(), job.clone());
    drop(connection_guard);
    emit(&recipient, card);
    if let Some((approval, prepared)) = auto {
        super::action_execution::start_prepared(state, job.clone(), &id, approval, prepared)?;
    }
    let state = state.clone();
    let action_id = id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let Ok(saved) = store::get_raw(&recipient, "app_actions", &action_id).await else {
                break;
            };
            if terminal(&saved["action"]) {
                break;
            }
            if *job.stopped.borrow()
                || state.apps.active().is_err()
                || (job.authorize)().await.is_err()
                || connections::prepare_call(
                    &job.source,
                    &job.prepared.connection_id,
                    &job.prepared.tool_name,
                    &job.prepared.arguments,
                )
                .await
                .map_or(true, |fresh| !fresh.matches(&job.prepared))
            {
                let _ = cancel(
                    &state,
                    &recipient,
                    &action_id,
                    "发起账户权限或应用授权已变化，原审批已取消。",
                )
                .await;
                break;
            }
            if saved["action"]["status"] == "pending" && expired(&saved["action"]) {
                let _ = cancel(&state, &recipient, &action_id, "应用操作审批已过期。").await;
                break;
            }
        }
    });
    Ok(saved["action"].clone())
}
fn expired(action: &Value) -> bool {
    action["expiresAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_none_or(|d| d.timestamp_millis() <= now())
}
pub fn terminal(action: &Value) -> bool {
    !["pending", "running"].contains(&action["status"].as_str().unwrap_or(""))
}
pub async fn get(store: &WorkspaceStore, id: &str) -> Result<Value> {
    Ok(store::get_raw(store, "app_actions", id).await?["action"].clone())
}
pub async fn decide(
    state: &State,
    recipient: &Arc<WorkspaceStore>,
    id: &str,
    approve: bool,
    actor: &WorkspaceAccess,
) -> Result<Value> {
    decide_inner(state, recipient, id, actor, approve, false).await
}

pub async fn always_allow(
    state: &State,
    recipient: &Arc<WorkspaceStore>,
    id: &str,
    actor: &WorkspaceAccess,
) -> Result<Value> {
    decide_inner(state, recipient, id, actor, true, true).await
}

async fn decide_inner(
    state: &State,
    recipient: &Arc<WorkspaceStore>,
    id: &str,
    actor: &WorkspaceAccess,
    approve: bool,
    always: bool,
) -> Result<Value> {
    let lock = state.apps.lock(&format!("action:{id}")).await;
    let _guard = lock.lock().await;
    actor.authorize(state).await?;
    let mut saved = store::get_raw(recipient, "app_actions", id).await?;
    let legacy = saved["action"].get("requester").is_none();
    if !legacy && saved["action"]["requester"]["userId"].as_str() != Some(actor.user_id.as_str()) {
        return Err(ApiError::new(
            403,
            "只有发起本次任务的成员可以处理这项审批。",
        ));
    }
    if legacy {
        actor.authorize_owner(state).await?;
    }
    let job = state
        .apps
        .jobs
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| ApiError::new(409, "这项审批已结束，不能再次执行。"))?;
    (job.authorize)().await?;
    if saved["action"]["status"] != "pending" || expired(&saved["action"]) {
        return Err(ApiError::new(409, "这项审批已处理或过期。"));
    }
    let connection = state
        .apps
        .lock(&format!(
            "{}:{}",
            job.source.workspace_id, job.prepared.connection_id
        ))
        .await;
    let _connection_guard = connection.lock().await;
    if always {
        return save_rule(state, recipient, id, actor, job, saved).await;
    }
    clear_offer(&mut saved);
    if !approve {
        saved["action"]["status"] = json!("rejected");
        saved["action"]["error"] = json!(if legacy {
            "空间拥有者拒绝了这次应用操作。"
        } else {
            "发起任务的成员拒绝了这次应用操作。"
        });
        job.stopped.send_replace(true);
        persist(recipient, &saved).await?;
        state.apps.jobs.lock().await.remove(id);
        return Ok(saved["action"].clone());
    }
    let fresh = connections::prepare_call(
        &job.source,
        &job.prepared.connection_id,
        &job.prepared.tool_name,
        &job.prepared.arguments,
    )
    .await?;
    if !fresh.matches(&job.prepared) {
        return Err(ApiError::new(409, "应用连接或工具已更改，请重新确认操作。"));
    }
    if legacy {
        actor.authorize_owner(state).await?;
    } else {
        actor.authorize(state).await?;
    }
    (job.authorize)().await?;
    saved["action"]["status"] = json!("running");
    saved["approvedBy"] = json!(actor.user_id);
    persist(recipient, &saved).await?;
    let response = saved["action"].clone();
    let approval: Authority = {
        let state = state.clone();
        let actor = actor.clone();
        Arc::new(move || {
            let (state, actor) = (state.clone(), actor.clone());
            Box::pin(async move {
                if legacy {
                    actor.authorize_owner(&state).await
                } else {
                    actor.authorize(&state).await
                }
            })
        })
    };
    super::action_execution::start(state, job, id, approval)?;
    Ok(response)
}

async fn save_rule(
    state: &State,
    recipient: &Arc<WorkspaceStore>,
    id: &str,
    actor: &WorkspaceAccess,
    job: Arc<Job>,
    mut saved: Value,
) -> Result<Value> {
    let (candidate, digest) = job.interactive.as_ref().ok_or_else(rules::changed)?;
    if !rules::allowed(actor)
        || candidate.actor.user_id != actor.user_id
        || saved["action"]["interactiveApproval"]["eligible"] != true
    {
        return Err(rules::changed());
    }
    actor.authorize_owner(state).await?;
    candidate.actor.authorize_owner(state).await?;
    (job.authorize)().await?;
    let mut tx = recipient.begin().await?;
    let scope = candidate
        .inspect(&mut tx, &job.prepared)
        .await?
        .filter(|scope| &scope.digest == digest)
        .ok_or_else(rules::changed)?;
    if expired(&saved["action"]) || *job.stopped.borrow() {
        return Err(rules::changed());
    }
    let (rule_id, usage) = scope.save(&mut tx, candidate, &job.prepared).await?;
    scope.mark(&mut saved, &rule_id, usage, &actor.user_id);
    let card = write_in(&mut tx, &saved).await?;
    actor.authorize_owner(state).await?;
    candidate.actor.authorize_owner(state).await?;
    state.apps.active()?;
    tx.commit().await?;
    emit(recipient, card);
    let approval = candidate.authority(state, recipient, &job.prepared, digest, &rule_id);
    let prepared = scope.restrict(job.prepared.clone());
    let approve_current_session = super::runtime::user_authority(state, actor);
    let approval: Authority = Arc::new(move || {
        let (approval, session) = (approval.clone(), approve_current_session.clone());
        Box::pin(async move {
            session().await?;
            approval().await
        })
    });
    super::action_execution::start_prepared(state, job, id, approval, prepared)?;
    Ok(saved["action"].clone())
}

pub(crate) fn clear_offer(saved: &mut Value) {
    if saved["action"]["interactiveApproval"]["eligible"] == true {
        if let Some(action) = saved["action"].as_object_mut() {
            action.remove("interactiveApproval");
        }
    }
}
pub async fn wait(
    state: &State,
    store: &WorkspaceStore,
    id: &str,
    authorize: Authority,
) -> Result<Value> {
    loop {
        if let Err(error) = authorize().await {
            let _ = cancel(state, store, id, "任务已停止，未执行的应用操作已取消。").await;
            return Err(error);
        }
        let value = get(store, id).await?;
        if terminal(&value) {
            return Ok(value);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
pub async fn cancel(state: &State, store: &WorkspaceStore, id: &str, reason: &str) -> Result<()> {
    let lock = state.apps.lock(&format!("action:{id}")).await;
    let _guard = lock.lock().await;
    if let Some(job) = state.apps.jobs.lock().await.get(id) {
        job.stopped.send_replace(true);
    }
    let mut saved = store::get_raw(store, "app_actions", id).await?;
    if terminal(&saved["action"]) {
        return Ok(());
    }
    let running = saved["action"]["status"] == "running";
    clear_offer(&mut saved);
    saved["action"]["status"] = json!(if running { "error" } else { "cancelled" });
    saved["action"]["error"] = json!(if running { UNKNOWN } else { reason });
    persist(store, &saved).await?;
    if let Some(job) = state.apps.jobs.lock().await.get(id) {
        job.stopped.send_replace(true);
    }
    if !running {
        state.apps.jobs.lock().await.remove(id);
    }
    Ok(())
}
pub async fn cancel_connection(state: &State, wid: &str, id: &str) {
    cancel_matching(state, wid, id, "应用连接已撤销，原审批已失效。", |_| true).await;
}

pub(super) async fn cancel_tool(
    state: &State,
    wid: &str,
    id: &str,
    name: &str,
    revision: Option<&str>,
) {
    cancel_matching(
        state,
        wid,
        id,
        "应用工具权限已变化，原审批已取消。",
        |prepared| {
            prepared.tool_name == name && prepared.tool_access_revision.as_deref() == revision
        },
    )
    .await;
}

async fn cancel_matching(
    state: &State,
    wid: &str,
    id: &str,
    reason: &str,
    matches: impl Fn(&PreparedCall) -> bool,
) {
    let jobs: Vec<_> = state
        .apps
        .jobs
        .lock()
        .await
        .iter()
        .filter(|(_, j)| {
            j.source.workspace_id == wid && j.prepared.connection_id == id && matches(&j.prepared)
        })
        .map(|(id, j)| (id.clone(), j.clone()))
        .collect();
    for (id, job) in jobs {
        let _ = cancel(state, &job.recipient, &id, reason).await;
    }
}
pub(crate) async fn persist(store: &WorkspaceStore, saved: &Value) -> Result<()> {
    let mut tx = store.begin().await?;
    let card = write_in(&mut tx, saved).await?;
    tx.commit().await?;
    emit(store, card);
    Ok(())
}

pub(crate) async fn write_in(
    tx: &mut sqlx::SqliteConnection,
    saved: &Value,
) -> Result<Option<Value>> {
    let action = &saved["action"];
    let status = action["status"].as_str().unwrap_or("");
    let mut card = json!({"id":saved["cardId"],"conversationId":action["conversationId"],"agentId":action["agentId"],"role":"assistant","kind":"approval","createdAt":action["createdAt"],"status":if ["pending","running"].contains(&status){"running"}else if status=="done"&&action["result"]["isError"]!=true{"done"}else{"error"},"content":match status{"pending"=>"应用操作等待发起人批准。","running"=>"应用操作正在执行。","done"=>"应用已返回结果。",_=>action["error"].as_str().unwrap_or("应用操作未执行。")},"metadata":{"appAction":action}});
    crate::agent::threads::stamp(&mut card, saved["threadRootId"].as_str());
    sqlx::query("INSERT INTO app_actions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(saved["id"].as_str()).bind(saved.to_string()).execute(&mut *tx).await?;
    let exists = WorkspaceStore::get_in(
        tx,
        Table::Conversations,
        action["conversationId"].as_str().unwrap_or(""),
    )
    .await?
    .is_some();
    if exists {
        WorkspaceStore::put_in(tx, Table::Messages, &card).await?;
    }
    Ok(exists.then_some(card))
}

pub(crate) fn emit(store: &WorkspaceStore, card: Option<Value>) {
    if let Some(card) = card {
        store.emit("message", card);
    }
    store.emit("update", json!({}));
}
