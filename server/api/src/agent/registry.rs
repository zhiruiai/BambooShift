use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, Notify, mpsc};

pub(crate) struct ActiveRun {
    pub run_id: String,
    pub root_run_id: String,
    pub requester_message_id: String,
    pub depth: u8,
    pub admitted_generation: u64,
    pub lineage: Vec<String>,
    pub family: Arc<super::delegation_family::DelegationFamily>,
    pub user_id: String,
    pub user_name: String,
    pub message_id: String,
    pub conversation_id: String,
    pub thread_root_id: Option<String>,
    pub agent_id: String,
    pub background: bool,
    pub kind: &'static str,
    pub memory_writes: AtomicUsize,
    pub memory_characters: AtomicUsize,
    pub cancelled: Arc<AtomicBool>,
    pub generation: Arc<AtomicU64>,
    pub commands: mpsc::Sender<Value>,
    pub finished: AtomicBool,
    pub changed: Notify,
}
#[derive(Default)]
pub struct AgentRegistry {
    closed: AtomicBool,
    active: Mutex<HashMap<String, Arc<ActiveRun>>>,
    pub(crate) queues: super::queue::InputQueues,
    pub(crate) admission_gates: super::admission_gate::AdmissionGates,
    pub(super) web_fixture: Option<super::exa_transport::Fixture>,
}
impl AgentRegistry {
    /// Only explicitly constructed test registries can send public web calls to a loopback fixture.
    pub fn with_web_fixture(origin: &str) -> crate::error::Result<Self> {
        Ok(Self {
            web_fixture: Some(super::exa_transport::Fixture::new(origin)?),
            ..Self::default()
        })
    }

    pub async fn workspace_busy(&self, workspace: &str) -> bool {
        let prefix = format!("{workspace}:");
        self.active
            .lock()
            .await
            .keys()
            .any(|key| key.starts_with(&prefix))
    }
    pub async fn yield_check_ins(&self, workspace: &str) {
        let prefix = format!("{workspace}:");
        let runs = self
            .active
            .lock()
            .await
            .iter()
            .filter(|(key, run)| key.starts_with(&prefix) && run.kind == "primary_checkin")
            .map(|(_, run)| run.clone())
            .collect::<Vec<_>>();
        for run in runs {
            let _ = run
                .commands
                .send(json!({"type":"abort","runId":run.run_id}))
                .await;
        }
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    pub async fn requests(&self, workspace: &str) -> Vec<Value> {
        let prefix = format!("{workspace}:");
        self.active.lock().await.iter().filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, run)| {
                let mut request = json!({"conversationId":run.conversation_id});
                super::threads::stamp(&mut request, run.thread_root_id.as_deref());
                if !run.background {
                    request["requester"] = json!({"userId":run.user_id,"name":run.user_name,"messageId":run.message_id});
                }
                request
            })
            .collect()
    }
    pub(crate) fn key(workspace: &str, conversation: &str) -> String {
        format!("{workspace}:{conversation}")
    }
    pub(crate) async fn get(&self, key: &str) -> Option<Arc<ActiveRun>> {
        self.active.lock().await.get(key).cloned()
    }
    pub(crate) async fn claim(&self, key: &str, run: Arc<ActiveRun>) -> bool {
        let mut active = self.active.lock().await;
        if self.closed.load(Ordering::Acquire) || active.contains_key(key) {
            return false;
        }
        active.insert(key.to_owned(), run);
        true
    }
    pub(crate) async fn release(&self, key: &str, run_id: &str) {
        let mut active = self.active.lock().await;
        if active.get(key).is_some_and(|run| run.run_id == run_id) {
            if let Some(run) = active.remove(key) {
                run.finished.store(true, Ordering::Release);
                run.changed.notify_waiters();
            }
        }
    }
    pub async fn agent_busy(&self, workspace: &str, agent: &str, excluding: Option<&str>) -> bool {
        let prefix = format!("{workspace}:");
        self.active.lock().await.iter().any(|(key, run)| {
            key.starts_with(&prefix)
                && ((run.agent_id == agent && excluding != Some(run.run_id.as_str()))
                    || run.family.children().iter().any(|child| {
                        child.agent_id == agent && excluding != Some(child.run_id.as_str())
                    }))
        })
    }
    pub async fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        let runs: Vec<_> = self.active.lock().await.values().cloned().collect();
        for run in &runs {
            run.cancelled.store(true, Ordering::Release);
            let _ = run
                .commands
                .send(json!({"type":"abort","runId":run.run_id}))
                .await;
        }
        for run in runs {
            loop {
                let changed = run.changed.notified();
                if run.finished.load(Ordering::Acquire) {
                    break;
                }
                changed.await;
            }
        }
    }
}
