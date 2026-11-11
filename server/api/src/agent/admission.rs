use super::{
    authority::ExecutionAccess,
    registry::{ActiveRun, AgentRegistry},
    runner,
};
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::WorkspaceStore,
};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, AtomicUsize},
};
use tokio::sync::{Notify, OwnedRwLockReadGuard, mpsc};

/// A pending reservation releases its registry claim if its request is canceled.
pub(crate) struct Reservation {
    pub active: Arc<ActiveRun>,
    registry: Arc<AgentRegistry>,
    key: String,
    receiver: Option<mpsc::Receiver<Value>>,
    _admission: OwnedRwLockReadGuard<()>,
}
impl Reservation {
    pub async fn reserve_scoped(
        state: &State,
        grant: &ExecutionAccess,
        conversation: &str,
        agent: &str,
        message_id: &str,
        kind: &'static str,
        thread_root_id: Option<&str>,
    ) -> Result<Self> {
        grant.authorize(state).await?;
        let admission = state.agent_runs.admission(grant.workspace_id()).await?;
        Self::reserve_admitted(
            state,
            grant,
            conversation,
            agent,
            message_id,
            kind,
            thread_root_id,
            admission,
        )
        .await
    }

    pub(crate) async fn reserve_kind_admitted(
        state: &State,
        grant: &ExecutionAccess,
        conversation: &str,
        agent: &str,
        message_id: &str,
        kind: &'static str,
        admission: OwnedRwLockReadGuard<()>,
    ) -> Result<Self> {
        grant.authorize(state).await?;
        Self::reserve_admitted(
            state,
            grant,
            conversation,
            agent,
            message_id,
            kind,
            None,
            admission,
        )
        .await
    }

    async fn reserve_admitted(
        state: &State,
        grant: &ExecutionAccess,
        conversation: &str,
        agent: &str,
        message_id: &str,
        kind: &'static str,
        thread_root_id: Option<&str>,
        admission: OwnedRwLockReadGuard<()>,
    ) -> Result<Self> {
        let key = AgentRegistry::key(grant.workspace_id(), conversation);
        let (commands, receiver) = mpsc::channel(32);
        let run_id = uuid::Uuid::new_v4().to_string();
        let active = Arc::new(ActiveRun {
            root_run_id: run_id.clone(),
            run_id,
            requester_message_id: message_id.to_owned(),
            depth: 0,
            admitted_generation: 0,
            lineage: vec![agent.to_owned()],
            family: Arc::new(super::delegation_family::DelegationFamily::new(kind)),
            user_id: grant.user_id().to_owned(),
            user_name: grant.user_name().to_owned(),
            message_id: message_id.to_owned(),
            conversation_id: conversation.to_owned(),
            thread_root_id: thread_root_id.map(str::to_owned),
            agent_id: agent.to_owned(),
            background: grant.background(),
            kind,
            memory_writes: AtomicUsize::new(0),
            memory_characters: AtomicUsize::new(0),
            cancelled: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            commands,
            finished: AtomicBool::new(false),
            changed: Notify::new(),
        });
        if !state.agent_runs.claim(&key, active.clone()).await {
            return Err(ApiError::new(409, "当前会话正在执行任务，请稍后发送。"));
        }
        if kind != "webhook" {
            state.teaching.interrupt_bot(grant.workspace_id(), agent);
        }
        Ok(Self {
            active,
            registry: state.agent_runs.clone(),
            key,
            receiver: Some(receiver),
            _admission: admission,
        })
    }
    pub async fn reserve_kind(
        state: &State,
        grant: &ExecutionAccess,
        conversation: &str,
        agent: &str,
        message_id: &str,
        kind: &'static str,
    ) -> Result<Self> {
        Self::reserve_scoped(state, grant, conversation, agent, message_id, kind, None).await
    }
    pub fn launch(
        mut self,
        state: State,
        access: ExecutionAccess,
        store: Arc<WorkspaceStore>,
        input: Value,
    ) {
        if let Ok(app) = serde_json::from_value(input["appContext"].clone()) {
            let _ = self.active.family.app_context.set(app);
        }
        if let Some(mentions) = input.get("mentions") {
            let ids = super::mentions::ids(mentions).map(str::to_owned).collect();
            let _ = self.active.family.mentioned_agents.set(ids);
        }
        if input["skillId"].is_string() {
            let _ = self.active.family.selected_skill.set(());
        }
        if input["metadata"]["voiceCallId"].is_string() {
            let _ = self.active.family.voice_call.set(());
        }
        if input["metadata"]["requestVoiceMemo"] == true {
            let _ = self.active.family.voice_memo.set(());
        }
        let receiver = self
            .receiver
            .take()
            .expect("A reservation is launched once");
        tokio::spawn(runner::run(
            state,
            access,
            store,
            self.active.clone(),
            receiver,
            input,
        ));
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if self.receiver.is_none() {
            return;
        }
        let registry = self.registry.clone();
        let key = self.key.clone();
        let run_id = self.active.run_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                registry.release(&key, &run_id).await;
            });
        }
    }
}
