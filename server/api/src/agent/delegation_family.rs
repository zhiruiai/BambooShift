use super::registry::ActiveRun;
use crate::{
    db::State,
    error::{ApiError, Result},
    shared_bots::{ResolvedSharedBot, SharedBotRunGrant},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

pub(super) struct RunKnowledge {
    pub skills: Vec<Value>,
    pub checkin_memories: Vec<Value>,
    pub lazy_skills: bool,
    pub lazy_memories: bool,
}

pub(crate) struct DelegationFamily {
    pub(super) root_kind: &'static str,
    pub(super) deadline: super::run_deadline::RunDeadline,
    snapshots: Mutex<HashMap<String, Value>>,
    local_definitions: Mutex<HashMap<String, (Value, Vec<Value>)>>,
    knowledge: Mutex<HashMap<String, Arc<RunKnowledge>>>,
    direct_grants: Mutex<Vec<super::private_delegation::DirectGrant>>,
    /// This in-memory snapshot contains credentials and is never serialized to workspace data.
    pub model_profile: OnceLock<Value>,
    pub(super) app_context: OnceLock<super::app_context::AppContext>,
    pub(super) mentioned_agents: OnceLock<Vec<String>>,
    pub(super) selected_skill: OnceLock<()>,
    pub(super) voice_call: OnceLock<()>,
    pub(super) voice_memo: OnceLock<()>,
    pub computer_tasks: tokio::sync::Mutex<
        HashMap<String, Arc<tokio::sync::Mutex<Option<crate::computer::tasks::TaskLease>>>>,
    >,
    definitions: Mutex<HashMap<String, Arc<ResolvedSharedBot>>>,
    grants: Mutex<Vec<SharedBotRunGrant>>,
    total: AtomicUsize,
    pub(super) web_searches: super::web_search_budget::WebSearchBudget,
    pub(super) routine_research: OnceLock<Arc<super::routine_web::RunResearch>>,
    pub web_fetches: AtomicUsize,
    slots: Arc<Semaphore>,
    children: Mutex<HashMap<String, Arc<ActiveRun>>>,
    changed: Notify,
}
impl DelegationFamily {
    pub fn new(root_kind: &'static str) -> Self {
        Self {
            root_kind,
            deadline: super::run_deadline::RunDeadline::new(root_kind),
            snapshots: Mutex::new(HashMap::new()),
            local_definitions: Mutex::new(HashMap::new()),
            knowledge: Mutex::new(HashMap::new()),
            direct_grants: Mutex::new(Vec::new()),
            model_profile: OnceLock::new(),
            app_context: OnceLock::new(),
            mentioned_agents: OnceLock::new(),
            selected_skill: OnceLock::new(),
            voice_call: OnceLock::new(),
            voice_memo: OnceLock::new(),
            computer_tasks: tokio::sync::Mutex::new(HashMap::new()),
            definitions: Mutex::new(HashMap::new()),
            grants: Mutex::new(Vec::new()),
            total: AtomicUsize::new(0),
            web_searches: Default::default(),
            routine_research: OnceLock::new(),
            web_fetches: AtomicUsize::new(0),
            slots: Arc::new(Semaphore::new(2)),
            children: Mutex::new(HashMap::new()),
            changed: Notify::new(),
        }
    }
    pub(super) fn isolated_voice(&self) -> bool {
        self.voice_call.get().is_some() || self.voice_memo.get().is_some()
    }
    pub(super) fn isolated_dispatch(&self) -> bool {
        self.app_context.get().is_some()
            || self.mentioned_agents.get().is_some()
            || self.selected_skill.get().is_some()
            || self.isolated_voice()
    }
    pub fn add_source(&self, grant: SharedBotRunGrant) {
        self.grants.lock().unwrap().push(grant);
    }
    pub fn has_shared_sources(&self) -> bool {
        !self.grants.lock().unwrap().is_empty()
    }
    pub fn snapshot(&self, id: &str) -> Option<Value> {
        self.snapshots.lock().unwrap().get(id).cloned()
    }
    pub fn capture_conversation(&self, chat: Value) -> Value {
        self.snapshots
            .lock()
            .unwrap()
            .entry(chat["id"].as_str().unwrap().to_owned())
            .or_insert(chat)
            .clone()
    }
    pub fn capture_local(&self, agent: Value, skills: Vec<Value>) -> (Value, Vec<Value>) {
        self.local_definitions
            .lock()
            .unwrap()
            .entry(agent["id"].as_str().unwrap().to_owned())
            .or_insert((agent, skills))
            .clone()
    }
    pub(super) fn capture_knowledge(
        &self,
        active: &ActiveRun,
        skills: Vec<Value>,
        memories: &[Value],
        requested_skill: Option<&str>,
    ) -> Result<super::run_knowledge::KnowledgePrompt> {
        let selection = requested_skill
            .map(|id| super::selected_skill::find(&skills, id, &active.agent_id))
            .transpose()?;
        let prompt = super::run_knowledge::prompt(&skills, memories, selection);
        let knowledge = RunKnowledge {
            skills,
            checkin_memories: if active.kind == "primary_checkin" {
                memories.to_vec()
            } else {
                vec![]
            },
            lazy_skills: prompt.lazy_skills,
            lazy_memories: prompt.lazy_memories,
        };
        self.knowledge
            .lock()
            .unwrap()
            .entry(active.run_id.clone())
            .or_insert_with(|| Arc::new(knowledge));
        Ok(prompt)
    }
    pub(super) fn knowledge(&self, run_id: &str) -> Option<Arc<RunKnowledge>> {
        self.knowledge.lock().unwrap().get(run_id).cloned()
    }
    pub fn add_direct(&self, grant: super::private_delegation::DirectGrant) {
        self.direct_grants.lock().unwrap().push(grant);
    }
    pub fn shared_definition(&self, alias: &str) -> Option<Arc<ResolvedSharedBot>> {
        self.definitions.lock().unwrap().get(alias).cloned()
    }
    pub fn cache_shared_definition(
        &self,
        alias: String,
        value: ResolvedSharedBot,
    ) -> Arc<ResolvedSharedBot> {
        self.definitions
            .lock()
            .unwrap()
            .entry(alias)
            .or_insert_with(|| Arc::new(value))
            .clone()
    }
    pub async fn authorize(&self, state: &State) -> Result<()> {
        let grants = self.grants.lock().unwrap().clone();
        for grant in grants {
            grant.authorize(state).await?;
        }
        let direct = self.direct_grants.lock().unwrap().clone();
        for grant in direct {
            grant.authorize(state).await?;
        }
        Ok(())
    }
    pub fn children(&self) -> Vec<Arc<ActiveRun>> {
        self.children.lock().unwrap().values().cloned().collect()
    }
    pub fn reserve(self: &Arc<Self>) -> Result<ChildReservation> {
        // Reject saturation instead of waiting while an ancestor holds the other slot.
        let permit =
            self.slots.clone().try_acquire_owned().map_err(|_| {
                ApiError::new(429, "本次协作已有两个子任务执行中，请等待当前结果。")
            })?;
        self.total
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |total| {
                (total < 8).then_some(total + 1)
            })
            .map_err(|_| ApiError::new(429, "本次任务最多委派八个子任务，请先总结已有结果。"))?;
        Ok(ChildReservation {
            family: self.clone(),
            _permit: permit,
            admitted: false,
        })
    }
    pub fn track(
        self: &Arc<Self>,
        active: Arc<ActiveRun>,
        reservation: ChildReservation,
    ) -> ChildLease {
        self.children
            .lock()
            .unwrap()
            .insert(active.run_id.clone(), active.clone());
        ChildLease {
            family: self.clone(),
            active,
            reservation,
        }
    }
    pub async fn wait(&self) {
        loop {
            let changed = self.changed.notified();
            if self.children.lock().unwrap().is_empty() {
                return;
            }
            changed.await;
        }
    }
}
pub(crate) struct ChildReservation {
    family: Arc<DelegationFamily>,
    _permit: OwnedSemaphorePermit,
    admitted: bool,
}
impl Drop for ChildReservation {
    fn drop(&mut self) {
        // Validation and transaction failures did not admit a child task.
        if !self.admitted {
            self.family.total.fetch_sub(1, Ordering::AcqRel);
        }
    }
}
pub(crate) struct ChildLease {
    family: Arc<DelegationFamily>,
    active: Arc<ActiveRun>,
    reservation: ChildReservation,
}
impl ChildLease {
    pub fn admit(&mut self) {
        // Committed children spend the budget even if execution later fails or stops.
        self.reservation.admitted = true;
    }
}
impl Drop for ChildLease {
    fn drop(&mut self) {
        self.active.finished.store(true, Ordering::Release);
        self.active.changed.notify_waiters();
        self.family
            .children
            .lock()
            .unwrap()
            .remove(&self.active.run_id);
        self.family.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abandoned_reservations_refund_budget_without_relaxing_concurrency_or_total() {
        let family = Arc::new(DelegationFamily::new("user"));
        for _ in 0..12 {
            let first = family.reserve().unwrap();
            let second = family.reserve().unwrap();
            assert!(family.reserve().is_err(), "Only two slots may be held");
            drop(first);
            drop(second);
        }
        for _ in 0..8 {
            let mut reservation = family.reserve().unwrap();
            reservation.admitted = true;
        }
        assert!(
            family.reserve().is_err(),
            "Eight admitted children exhaust the budget"
        );
        assert_eq!(family.slots.available_permits(), 2);
    }
}
