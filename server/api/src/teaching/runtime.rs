use crate::{
    computer::{controller::Controller, controls::Lease},
    db::State,
    error::{ApiError, Result},
    workspace::{WorkspaceAccess, WorkspaceStore},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, Semaphore, watch};

pub struct Live {
    pub id: String,
    pub state: State,
    pub actor: WorkspaceAccess,
    pub store: Arc<WorkspaceStore>,
    pub agent: String,
    pub conversation: String,
    pub controller: Weak<Controller>,
    pub lease: Option<Lease>,
    pub serial: Arc<Semaphore>,
    pub cancelled: watch::Sender<bool>,
    pub reason: Mutex<Option<&'static str>>,
    pub ended: AtomicBool,
    pub recording: bool,
}
impl Live {
    pub fn interrupt(&self, reason: &'static str) {
        if !self.ended.load(Ordering::Acquire) {
            self.reason.lock().unwrap().get_or_insert(reason);
            self.cancelled.send_replace(true);
        }
    }
    pub fn check(&self) -> Result<()> {
        if *self.cancelled.borrow() || self.ended.load(Ordering::Acquire) || self.state.is_closing()
        {
            return Err(ApiError::new(409, "教学已中断，请查看保留的记录。"));
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct TeachingRuntime {
    active: Mutex<HashMap<(String, String), Arc<Live>>>,
    closed: AtomicBool,
    changed: Notify,
}
impl TeachingRuntime {
    pub fn insert(&self, live: Arc<Live>) -> Result<()> {
        let mut active = self.active.lock().unwrap();
        if self.closed.load(Ordering::Acquire) || live.state.is_closing() {
            return Err(ApiError::new(503, "服务正在停止。"));
        }
        if active.contains_key(&(live.actor.workspace_id.clone(), live.id.clone()))
            || active.values().any(|old| {
                old.actor.workspace_id == live.actor.workspace_id && old.agent == live.agent
            })
        {
            return Err(ApiError::new(
                409,
                "此 Bot 已有教学记录或技能生成正在进行。",
            ));
        }
        active.insert((live.actor.workspace_id.clone(), live.id.clone()), live);
        Ok(())
    }
    pub fn get(&self, workspace: &str, id: &str) -> Option<Arc<Live>> {
        self.active
            .lock()
            .unwrap()
            .get(&(workspace.to_owned(), id.to_owned()))
            .cloned()
    }
    pub fn for_agent(&self, workspace: &str, agent: &str) -> Option<Arc<Live>> {
        self.active
            .lock()
            .unwrap()
            .values()
            .find(|v| v.actor.workspace_id == workspace && v.agent == agent && v.recording)
            .cloned()
    }
    pub fn remove(&self, live: &Arc<Live>) {
        let mut active = self.active.lock().unwrap();
        let key = (live.actor.workspace_id.clone(), live.id.clone());
        if active
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, live))
        {
            active.remove(&key);
        }
        self.changed.notify_waiters();
    }
    pub fn interrupt_bot(&self, workspace_id: &str, agent_id: &str) {
        if let Some(live) = self.for_agent(workspace_id, agent_id) {
            live.interrupt("bot_started_work");
        }
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        loop {
            let notified = self.changed.notified();
            {
                let active = self.active.lock().unwrap();
                if active.is_empty() {
                    break;
                }
                for live in active.values() {
                    live.interrupt("service_stopped");
                }
            }
            notified.await;
        }
    }
}
