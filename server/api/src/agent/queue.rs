use super::{admission::Reservation, authority::ExecutionAccess, mentions, registry::ActiveRun};
use crate::{
    db::State,
    error::Result,
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};
use tokio::sync::{Mutex, OwnedMutexGuard};

#[derive(Clone)]
pub(crate) struct PendingInput {
    pub access: ExecutionAccess,
    pub message: Value,
    pub injected: bool,
    pub kind: &'static str,
    pub generation: Option<u64>,
    pub execution_prompt: Option<String>,
    pub recipient: Option<String>,
}
#[derive(Default)]
pub(crate) struct InputQueues {
    gates: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    inputs: Mutex<HashMap<String, Vec<PendingInput>>>,
}
impl InputQueues {
    pub async fn workspace_pending(&self, workspace: &str) -> bool {
        let prefix = format!("{workspace}:");
        self.inputs
            .lock()
            .await
            .iter()
            .any(|(key, items)| key.starts_with(&prefix) && !items.is_empty())
    }
    pub async fn lock(&self, key: &str) -> OwnedMutexGuard<()> {
        let gate = {
            let mut gates = self.gates.lock().await;
            gates.retain(|_, gate| gate.strong_count() > 0);
            match gates.get(key).and_then(Weak::upgrade) {
                Some(gate) => gate,
                None => {
                    let gate = Arc::new(Mutex::new(()));
                    gates.insert(key.to_owned(), Arc::downgrade(&gate));
                    gate
                }
            }
        };
        gate.lock_owned().await
    }
    pub async fn len(&self, key: &str) -> usize {
        self.inputs.lock().await.get(key).map_or(0, Vec::len)
    }
    pub async fn has_isolated_dispatch(&self, key: &str) -> bool {
        self.inputs.lock().await.get(key).is_some_and(|items| {
            items.iter().any(|input| {
                input.recipient.is_some()
                    || input.message["skillId"].is_string()
                    || input.message["metadata"]["requestVoiceMemo"] == true
                    || input.message["metadata"].get("questionAnswer").is_some()
            })
        })
    }
    pub async fn push_user(
        &self,
        key: &str,
        access: ExecutionAccess,
        message: Value,
        generation: Option<u64>,
        skip_first: bool,
    ) {
        if let Some(resolved) = message.get("mentions") {
            let recipients = mentions::ids(resolved).skip(usize::from(skip_first));
            let mut inputs = self.inputs.lock().await;
            inputs
                .entry(key.to_owned())
                .or_default()
                .extend(recipients.map(|recipient| PendingInput {
                    access: access.clone(),
                    message: message.clone(),
                    injected: false,
                    generation: None,
                    kind: "user",
                    execution_prompt: None,
                    recipient: Some(recipient.to_owned()),
                }));
        } else {
            self.push_inner(key, access, message, "user", None, generation)
                .await;
        }
    }
    pub async fn push_kind(
        &self,
        key: &str,
        access: ExecutionAccess,
        message: Value,
        kind: &'static str,
        execution_prompt: Option<String>,
    ) {
        self.push_inner(key, access, message, kind, execution_prompt, None)
            .await;
    }
    async fn push_inner(
        &self,
        key: &str,
        access: ExecutionAccess,
        mut message: Value,
        kind: &'static str,
        execution_prompt: Option<String>,
        generation: Option<u64>,
    ) {
        message.as_object_mut().unwrap().remove("executionPrompt");
        self.inputs
            .lock()
            .await
            .entry(key.to_owned())
            .or_default()
            .push(PendingInput {
                access,
                message,
                injected: false,
                generation,
                kind,
                execution_prompt,
                recipient: None,
            });
    }
    pub async fn pop(&self, key: &str) -> Option<PendingInput> {
        let mut queues = self.inputs.lock().await;
        let items = queues.get_mut(key)?;
        if items.is_empty() {
            queues.remove(key);
            None
        } else {
            Some(items.remove(0))
        }
    }
    pub async fn injection(&self, key: &str, run: &ActiveRun) -> Vec<PendingInput> {
        if run.family.isolated_dispatch() {
            return vec![];
        }
        let mut inputs = self.inputs.lock().await;
        let Some(items) = inputs.get_mut(key) else {
            return vec![];
        };
        items
            .iter_mut()
            // Explicit group dispatches, skills, and voice memo requests start their own runs.
            .take_while(|input| {
                input.recipient.is_none()
                    && input.message["skillId"].is_null()
                    && input.message["metadata"]["requestVoiceMemo"] != true
                    && input.message["metadata"].get("questionAnswer").is_none()
            })
            .filter(|input| {
                !input.injected
                    && input.kind == "user"
                    && input.message.get("appContext").is_none()
                    && super::threads::belongs(&input.message, run.thread_root_id.as_deref())
                    && input.access.user_id() == run.user_id
                    && input.message["delivery"]["agentId"] == run.agent_id
            })
            .map(|input| {
                input.injected = true;
                input.clone()
            })
            .collect()
    }
    pub async fn delivered(&self, key: &str, id: &str) -> Option<PendingInput> {
        let mut inputs = self.inputs.lock().await;
        let items = inputs.get_mut(key)?;
        let index = items.iter().position(|input| {
            input.injected && input.recipient.is_none() && input.message["id"] == id
        })?;
        Some(items.remove(index))
    }
    pub async fn cancel_actor(
        &self,
        key: &str,
        user: &str,
        scope: Option<Option<&str>>,
        include_explicit_dispatches: bool,
        store: &WorkspaceStore,
        reason: &str,
    ) -> Result<()> {
        let removed = {
            let mut inputs = self.inputs.lock().await;
            let Some(items) = inputs.get_mut(key) else {
                return Ok(());
            };
            let matches = |input: &PendingInput| {
                input.access.user_id() == user
                    && input.kind == "user"
                    && (include_explicit_dispatches
                        || (input.recipient.is_none() && input.message["skillId"].is_null()))
                    && scope.is_none_or(|scope| super::threads::belongs(&input.message, scope))
            };
            let removed = items
                .iter()
                .filter(|input| matches(input))
                .cloned()
                .collect::<Vec<_>>();
            items.retain(|input| !matches(input));
            removed
        };
        for input in removed {
            mark_pending(store, &input, "cancelled", reason).await?;
        }
        Ok(())
    }
}
pub(crate) async fn mark(
    store: &WorkspaceStore,
    message: &Value,
    status: &str,
    reason: &str,
) -> Result<()> {
    mark_delivery(store, message, None, status, reason).await
}
async fn mark_pending(
    store: &WorkspaceStore,
    input: &PendingInput,
    status: &str,
    reason: &str,
) -> Result<()> {
    mark_delivery(
        store,
        &input.message,
        input.recipient.as_deref(),
        status,
        reason,
    )
    .await
}
async fn mark_delivery(
    store: &WorkspaceStore,
    message: &Value,
    recipient: Option<&str>,
    status: &str,
    reason: &str,
) -> Result<()> {
    let mut tx = store.begin().await?;
    if let Some(mut current) = WorkspaceStore::get_in(
        &mut tx,
        Table::Messages,
        message["id"].as_str().unwrap_or(""),
    )
    .await?
    {
        let changed = if let Some(agent) = recipient {
            mentions::abandon(&mut current, agent, status, reason)
        } else if current["delivery"]["state"] == "queued" {
            current["delivery"]["state"] = json!(status);
            current["delivery"]["reason"] = json!(reason);
            true
        } else {
            false
        };
        if changed {
            WorkspaceStore::put_in(&mut tx, Table::Messages, &current).await?;
            tx.commit().await?;
            store.emit("message", current);
        }
    }
    Ok(())
}
pub(crate) async fn advance(state: &State, store: &Arc<WorkspaceStore>, key: &str, old_run: &str) {
    let _gate = state.agent_runs.queues.lock(key).await;
    state.agent_runs.release(key, old_run).await;
    while let Some(pending) = state.agent_runs.queues.pop(key).await {
        let input = &pending.message;
        if state.agent_runs.is_closed() || pending.access.authorize(state).await.is_err() {
            let _ = mark_pending(
                store,
                &pending,
                "interrupted",
                "原任务权限已失效，消息不会自动重发。",
            )
            .await;
            continue;
        }
        let cid = input["conversationId"].as_str().unwrap_or("");
        let aid = pending
            .recipient
            .as_deref()
            .or_else(|| input["delivery"]["agentId"].as_str())
            .unwrap_or("");
        let mid = input["id"].as_str().unwrap_or("");
        let Some(current) = store.get(Table::Messages, mid).await.ok().flatten() else {
            continue;
        };
        if pending.recipient.is_some() {
            if !mentions::queued(&current, aid) {
                continue;
            }
            let remains_member = store
                .get(Table::Conversations, cid)
                .await
                .ok()
                .flatten()
                .is_some_and(|chat| {
                    chat["isGroup"] == true
                        && chat["agentIds"]
                            .as_array()
                            .is_some_and(|members| members.iter().any(|member| member == aid))
                });
            if !remains_member {
                let _ =
                    mark_pending(store, &pending, "interrupted", "被提及的 Bot 已离开群聊。").await;
                continue;
            }
        } else if current["delivery"]["state"] != "queued" {
            continue;
        }
        match Reservation::reserve_scoped(
            state,
            &pending.access,
            cid,
            aid,
            mid,
            pending.kind,
            input["threadRootId"].as_str(),
        )
        .await
        {
            Ok(reservation) => {
                let mut message = input.clone();
                let mut tx = match store.begin().await {
                    Ok(tx) => tx,
                    Err(_) => {
                        state
                            .agent_runs
                            .release(key, &reservation.active.run_id)
                            .await;
                        let _ = mark_pending(
                            store,
                            &pending,
                            "interrupted",
                            "消息未能开始执行，请核对原请求。",
                        )
                        .await;
                        continue;
                    }
                };
                let saved = async {
                    if pending.recipient.is_some() {
                        message = WorkspaceStore::get_in(&mut tx, Table::Messages, mid)
                            .await?
                            .ok_or_else(mentions::unavailable)?;
                        mentions::assign(&mut message, aid, &reservation.active.run_id)?;
                    } else {
                        message["delivery"]["runId"] = json!(reservation.active.run_id);
                    }
                    WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
                    if let Some(mut bot) =
                        WorkspaceStore::get_in(&mut tx, Table::Agents, aid).await?
                    {
                        bot["status"] = json!("working");
                        WorkspaceStore::put_in(&mut tx, Table::Agents, &bot).await?;
                    }
                    pending.access.authorize(state).await?;
                    Result::<()>::Ok(())
                }
                .await;
                if saved.is_err() {
                    drop(tx);
                    state
                        .agent_runs
                        .release(key, &reservation.active.run_id)
                        .await;
                    let _ = mark_pending(
                        store,
                        &pending,
                        "interrupted",
                        "消息未能开始执行，请核对原请求。",
                    )
                    .await;
                    continue;
                }
                if tx.commit().await.is_err() {
                    state
                        .agent_runs
                        .release(key, &reservation.active.run_id)
                        .await;
                    let _ = mark_pending(
                        store,
                        &pending,
                        "interrupted",
                        "消息未能开始执行，请核对原请求。",
                    )
                    .await;
                    continue;
                }
                store.emit("message", message.clone());
                if let Some(prompt) = pending.execution_prompt {
                    message["executionPrompt"] = json!(prompt);
                }
                reservation.launch(state.clone(), pending.access, store.clone(), message);
                break;
            }
            Err(_) => {
                let _ = mark_pending(
                    store,
                    &pending,
                    "interrupted",
                    "消息未能开始执行，请核对原请求。",
                )
                .await;
            }
        }
    }
}
