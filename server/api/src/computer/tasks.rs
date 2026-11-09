use super::{approvals, controller::Controller, model, screen_bindings, transport::Authority};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Default)]
struct Status {
    active: Option<(String, String)>,
    queued: usize,
    blocked: bool,
    maintenance: bool,
    cleaning: bool,
}
struct Slot {
    serial: Arc<Semaphore>,
    state: Mutex<Status>,
}
#[derive(Default)]
pub struct Tasks {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}
impl Tasks {
    fn slot(&self, agent: &str) -> Arc<Slot> {
        self.slots
            .lock()
            .unwrap()
            .entry(agent.into())
            .or_insert_with(|| {
                Arc::new(Slot {
                    serial: Arc::new(Semaphore::new(1)),
                    state: Mutex::new(Status::default()),
                })
            })
            .clone()
    }
    pub fn state(&self, agent: &str) -> Value {
        let slot = self.slot(agent);
        let value = slot.state.lock().unwrap();
        let status = if value.maintenance {
            "maintenance"
        } else if value.blocked {
            "blocked"
        } else if value.cleaning {
            "waiting_cleanup"
        } else if value.active.is_some() {
            "running"
        } else {
            "idle"
        };
        let mut out = json!({"status":status,"queued":value.queued});
        if let Some((_, conversation)) = &value.active {
            out["conversationId"] = json!(conversation);
        }
        out
    }
    pub fn busy(&self, agent: Option<&str>) -> bool {
        self.slots
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| agent.is_none_or(|a| a == id.as_str()))
            .any(|(_, slot)| {
                let s = slot.state.lock().unwrap();
                s.active.is_some() || s.queued > 0 || s.cleaning || s.maintenance
            })
    }
    pub fn maintain(&self, agent: &str) -> Result<Maintenance> {
        let slot = self.slot(agent);
        let mut state = slot.state.lock().unwrap();
        if state.active.is_some() || state.queued > 0 || state.cleaning || state.maintenance {
            return Err(ApiError::new(409, "请先结束此 Bot 的当前任务和排队工作。"));
        }
        state.maintenance = true;
        drop(state);
        Ok(Maintenance(slot))
    }
    pub fn block(&self, agent: &str) {
        self.slot(agent).state.lock().unwrap().blocked = true;
    }
    pub fn blocked(&self, agent: Option<&str>) -> bool {
        self.slot(agent.unwrap_or("default"))
            .state
            .lock()
            .unwrap()
            .blocked
    }
    pub fn clear_blocked(&self, agent: &str) {
        self.slot(agent).state.lock().unwrap().blocked = false;
    }
}
pub struct Maintenance(Arc<Slot>);
impl Drop for Maintenance {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().maintenance = false;
    }
}
struct Waiting(Arc<Slot>);
impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().queued -= 1;
    }
}
pub struct TaskLease {
    controller: Weak<Controller>,
    slot: Arc<Slot>,
    run_id: String,
    agent_id: String,
    shared: bool,
    permit: Option<OwnedSemaphorePermit>,
}
pub async fn acquire(
    controller: &Arc<Controller>,
    agent: &str,
    conversation: &str,
    run_id: &str,
    authorize: Authority,
) -> Result<TaskLease> {
    controller.active()?;
    authorize().await?;
    screen_bindings::require_agent(&controller.store, agent).await?;
    // Reserve the selected surface while connection management is excluded.
    // A local browser is one shared resource, not one resource per Bot.
    let management = controller.management.lock().await;
    let shared = controller.uses_shared_screen().await;
    let slot = controller
        .tasks
        .slot(if shared { "default" } else { agent });
    {
        let mut value = slot.state.lock().unwrap();
        if value.blocked || value.maintenance {
            return Err(model::blocked());
        }
        value.queued += 1;
    }
    let waiting = Waiting(slot.clone());
    drop(management);
    controller.changed();
    let permit = {
        let acquire = slot.serial.clone().acquire_owned();
        tokio::pin!(acquire);
        loop {
            tokio::select! {
                permit=&mut acquire=>break permit.map_err(|_|model::blocked())?,
                _=tokio::time::sleep(std::time::Duration::from_millis(200))=>{controller.active()?;authorize().await?;}
            }
        }
    };
    controller.active()?;
    authorize().await?;
    {
        let mut value = slot.state.lock().unwrap();
        if value.blocked || value.maintenance {
            return Err(model::blocked());
        }
        value.active = Some((run_id.into(), conversation.into()));
    }
    drop(waiting);
    controller.changed();
    let lease = TaskLease {
        controller: Arc::downgrade(controller),
        slot,
        run_id: run_id.into(),
        agent_id: agent.into(),
        shared,
        permit: Some(permit),
    };
    screen_bindings::prepare(controller, agent, authorize).await?;
    Ok(lease)
}
impl TaskLease {
    pub async fn finish(mut self) -> Result<()> {
        let permit = self.permit.take();
        cleanup(
            self.controller.clone(),
            self.slot.clone(),
            self.run_id.clone(),
            self.agent_id.clone(),
            self.shared,
            permit,
        )
        .await
    }
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            let controller = self.controller.clone();
            let slot = self.slot.clone();
            let run = self.run_id.clone();
            let agent = self.agent_id.clone();
            let shared = self.shared;
            slot.state.lock().unwrap().cleaning = true;
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let _ = cleanup(controller, slot, run, agent, shared, Some(permit)).await;
                });
            } else {
                let mut state = slot.state.lock().unwrap();
                state.active = None;
                state.blocked = true;
                state.cleaning = false;
            }
        }
    }
}
async fn cleanup(
    controller: Weak<Controller>,
    slot: Arc<Slot>,
    run: String,
    agent: String,
    shared: bool,
    _permit: Option<OwnedSemaphorePermit>,
) -> Result<()> {
    slot.state.lock().unwrap().cleaning = true;
    let result = if let Some(controller) = controller.upgrade() {
        controller.changed();
        let jobs: Vec<_> = controller
            .jobs
            .lock()
            .await
            .iter()
            .filter(|(_, j)| j.context.run_id.as_deref() == Some(&run))
            .map(|(id, j)| (id.clone(), j.clone()))
            .collect();
        let mut failure = None;
        for (id, job) in jobs {
            if !*job.finished.borrow() {
                if let Err(error) =
                    approvals::cancel(&controller, &id, "原任务已结束，未完成的电脑操作已取消。")
                        .await
                {
                    failure = Some(error);
                }
            }
            let mut finished = job.finished.subscribe();
            loop {
                let done = *finished.borrow_and_update();
                if done {
                    break;
                }
                if finished.changed().await.is_err() {
                    failure = Some(model::blocked());
                    break;
                }
            }
            if job.target.is_blocked() {
                failure = Some(model::blocked());
            }
        }
        let target = if shared {
            controller.target.lock().await.clone()
        } else {
            controller.screen_targets.lock().await.get(&agent).cloned()
        };
        if let Some(target) = target {
            target.wait_idle().await;
            if target.is_blocked() {
                failure = Some(model::blocked());
            }
        }
        if slot.state.lock().unwrap().blocked {
            failure = Some(model::blocked());
        }
        if failure.is_some() {
            if let Err(error) = super::action_store::mark_recovery(
                &controller.store,
                if shared { "default" } else { &agent },
            )
            .await
            {
                failure = Some(error);
            }
        }
        let mut status = slot.state.lock().unwrap();
        status.active = None;
        status.cleaning = false;
        status.blocked = failure.is_some();
        drop(status);
        controller.changed();
        failure.map_or(Ok(()), Err)
    } else {
        let mut status = slot.state.lock().unwrap();
        status.active = None;
        status.cleaning = false;
        status.blocked = true;
        Err(model::blocked())
    };
    result
}
