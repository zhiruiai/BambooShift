use super::{
    model::{self, SavedRemote, ScreenBinding},
    private_config::{self, SavedConnection},
    transport::{Authority, Request, Target},
};
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::{WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;

pub struct ComputerRuntime {
    controllers: Mutex<HashMap<String, Arc<Controller>>>,
    closed: AtomicBool,
}
impl Default for ComputerRuntime {
    fn default() -> Self {
        Self {
            controllers: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }
}
impl ComputerRuntime {
    pub async fn get(&self, state: &State, store: Arc<WorkspaceStore>) -> Result<Arc<Controller>> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ApiError::new(503, "电脑服务正在关闭。"));
        }
        let mut all = self.controllers.lock().await;
        if let Some(controller) = all.get(&store.workspace_id) {
            return Ok(controller.clone());
        }
        let controller =
            Controller::open(store, state.config.clone(), state.teaching.clone()).await?;
        all.insert(controller.store.workspace_id.clone(), controller.clone());
        Ok(controller)
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let controllers: Vec<_> = self.controllers.lock().await.values().cloned().collect();
        for controller in controllers {
            controller.close().await;
        }
    }
}
pub struct Controller {
    pub store: Arc<WorkspaceStore>,
    pub(crate) teaching: Arc<crate::teaching::TeachingRuntime>,
    pub(crate) management: Mutex<()>,
    pub(crate) saved: Mutex<Option<SavedConnection>>,
    pub(crate) target: Mutex<Option<Arc<Target>>>,
    pub(crate) local: Mutex<Option<super::local_executor::LocalExecutor>>,
    pub(crate) screen_targets: Mutex<HashMap<String, Arc<Target>>>,
    pub(crate) bindings: Mutex<super::screen_bindings::Journal>,
    pub(crate) jobs: Mutex<HashMap<String, Arc<super::approvals::Job>>>,
    pub(crate) takeovers: Mutex<HashMap<String, super::controls::Lease>>,
    pub(crate) origin: Option<String>,
    runtime: Arc<crate::config::Config>,
    pub tasks: super::tasks::Tasks,
    pub cloud: Arc<super::cloud::Cloud>,
    closed: AtomicBool,
}
impl Controller {
    async fn open(
        store: Arc<WorkspaceStore>,
        runtime: Arc<crate::config::Config>,
        teaching: Arc<crate::teaching::TeachingRuntime>,
    ) -> Result<Arc<Self>> {
        let saved = private_config::read(&store.directory)?;
        let bindings = super::screen_bindings::load(&store)?;
        let recovered = super::action_store::initialize(&store).await?;
        let tasks = super::tasks::Tasks::default();
        for agent in recovered {
            tasks.block(&agent);
        }
        let cloud = super::cloud::Cloud::open(&store.directory, &store.workspace_id);
        Ok(Arc::new(Self {
            store,
            teaching,
            management: Mutex::new(()),
            saved: Mutex::new(saved),
            target: Mutex::new(None),
            local: Mutex::new(None),
            screen_targets: Mutex::new(HashMap::new()),
            bindings: Mutex::new(bindings),
            jobs: Mutex::new(HashMap::new()),
            takeovers: Mutex::new(HashMap::new()),
            origin: runtime.public_origin.clone(),
            runtime,
            tasks,
            cloud,
            closed: AtomicBool::new(false),
        }))
    }
    pub fn active(&self) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            Err(ApiError::new(503, "电脑服务正在关闭。"))
        } else {
            Ok(())
        }
    }
    pub(crate) async fn is_local(&self) -> bool {
        self.saved
            .lock()
            .await
            .as_ref()
            .is_some_and(|saved| saved.selection == "local")
    }
    pub(crate) async fn uses_shared_screen(&self) -> bool {
        self.saved.lock().await.as_ref().is_some_and(|saved| {
            saved.selection == "local"
                || (saved.selection == "remote"
                    && saved
                        .remote
                        .as_ref()
                        .is_some_and(|remote| remote.has(model::SHARED_SCREEN)))
        })
    }
    pub async fn state(&self) -> Value {
        let (target, saved) = {
            let target = self.target.lock().await;
            (target.clone(), self.saved.lock().await.clone())
        };
        let mut value = match target {
            Some(t) => t.state().await,
            None => model::disconnected(),
        };
        let selection = saved.as_ref().map(|saved| saved.selection.as_str());
        let remote = saved.as_ref().and_then(|saved| saved.remote.as_ref());
        if let Some(remote) = remote {
            value["savedRemote"] = json!({"name":remote.name,"url":remote.url});
        }
        if value["targetRevision"].is_null()
            && selection == Some("remote")
            && remote.is_some_and(|remote| remote.has(model::SHARED_SCREEN))
        {
            value["capabilities"] = json!([model::SHARED_SCREEN]);
        }
        if selection == Some("local") {
            value["mode"] = json!("local");
        }
        value["executionLocation"] = json!(match selection {
            Some("local") => "server",
            Some("remote") if remote.is_some_and(|r| self.cloud.matches_worker(&r.url)) => "cloud",
            Some("remote") => "remote",
            _ => "none",
        });
        if self.tasks.blocked(None) {
            value["connected"] = json!(false);
            value["status"] = json!("原电脑操作清理尚未确认，请维护后重新连接。");
        }
        value
    }
    pub async fn target(self: &Arc<Self>, authorize: Authority) -> Result<Arc<Target>> {
        self.active()?;
        authorize().await?;
        let mut current = self.target.lock().await;
        if let Some(target) = current.as_ref() {
            target.active()?;
            return Ok(target.clone());
        }
        let selection = self.saved.lock().await.clone();
        if selection.as_ref().is_some_and(|s| s.selection == "local") {
            let executor = super::local_executor::LocalExecutor::start(
                &self.runtime,
                &self.store.directory,
                &self.store.workspace_id,
                self.origin.as_deref(),
            )
            .await?;
            let target = Target::discover(
                &executor.url,
                &executor.token,
                &self.store.workspace_id,
                self.origin.as_deref(),
                None,
                None,
                authorize.clone(),
            )
            .await?;
            authorize().await?;
            self.active()?;
            *self.local.lock().await = Some(executor);
            *current = Some(target.clone());
            return Ok(target);
        }
        let saved = selection
            .filter(|s| s.selection == "remote")
            .and_then(|s| s.remote)
            .ok_or_else(|| ApiError::new(409, "请先连接工作电脑。"))?;
        let probe = self.cloud.guard(&saved.url);
        if let Some(probe) = &probe {
            probe().await?;
        }
        let target = Target::discover(
            &saved.url,
            &saved.token,
            &self.store.workspace_id,
            self.origin.as_deref(),
            None,
            Some(&saved),
            authorize.clone(),
        )
        .await?;
        target.set_probe(probe).await;
        authorize().await?;
        self.active()?;
        *current = Some(target.clone());
        Ok(target)
    }
    pub async fn refresh(self: &Arc<Self>, authorize: Authority) -> Value {
        if let Ok(target) = self.target(authorize.clone()).await {
            let _ = target.request(Request::get("/health"), authorize).await;
        }
        self.state().await
    }
    pub async fn connect(
        self: &Arc<Self>,
        url: &str,
        token: &str,
        authorize: Authority,
    ) -> Result<Value> {
        let _guard = self.management.lock().await;
        self.active()?;
        authorize().await?;
        self.assert_global_change().await?;
        let probe = self.cloud.guard(url);
        if let Some(probe) = &probe {
            probe().await?;
        }
        let discovered = Target::discover(
            url,
            token,
            &self.store.workspace_id,
            self.origin.as_deref(),
            None,
            None,
            authorize.clone(),
        )
        .await?;
        self.validate_default_recovery(&discovered).await?;
        discovered.set_probe(probe).await;
        let idle = discovered
            .request(Request::get("/takeover/status"), authorize.clone())
            .await?
            .json()?;
        if idle["active"] != false {
            return Err(ApiError::new(409, "电脑仍在人工接管，请先结束接管。"));
        }
        authorize().await?;
        self.install_remote(discovered, &authorize).await?;
        self.clear_default_recovery().await?;
        self.changed();
        Ok(self.state().await)
    }
    pub async fn connect_local(self: &Arc<Self>, authorize: Authority) -> Result<Value> {
        let _guard = self.management.lock().await;
        self.active()?;
        authorize().await?;
        self.assert_global_change().await?;
        if self.tasks.blocked(None)
            && !self.is_local().await
            && self.configured_remote().await.is_some()
        {
            return Err(model::blocked());
        }
        let mut current = self.target.lock().await;
        self.retire_local(&mut current).await?;
        let executor = super::local_executor::LocalExecutor::start(
            &self.runtime,
            &self.store.directory,
            &self.store.workspace_id,
            self.origin.as_deref(),
        )
        .await?;
        let target = Target::discover(
            &executor.url,
            &executor.token,
            &self.store.workspace_id,
            self.origin.as_deref(),
            None,
            None,
            authorize.clone(),
        )
        .await?;
        authorize().await?;
        let saved = SavedConnection {
            version: 1,
            selection: "local".into(),
            remote: self.configured_remote().await,
        };
        private_config::write(&self.store.directory, &saved)?;
        let previous = current.replace(target);
        *self.local.lock().await = Some(executor);
        *self.saved.lock().await = Some(saved);
        drop(current);
        if let Some(previous) = previous {
            previous.close().await;
        }
        self.clear_default_recovery().await?;
        self.changed();
        Ok(self.state().await)
    }
    pub async fn disconnect(self: &Arc<Self>, authorize: Authority) -> Result<Value> {
        let _guard = self.management.lock().await;
        self.active()?;
        authorize().await?;
        self.assert_global_change().await?;
        let saved = SavedConnection {
            version: 1,
            selection: "disconnected".into(),
            remote: self.configured_remote().await,
        };
        let mut current = self.target.lock().await;
        self.retire_local(&mut current).await?;
        authorize().await?;
        private_config::write(&self.store.directory, &saved)?;
        let target = current.take();
        *self.saved.lock().await = Some(saved);
        drop(current);
        if let Some(target) = target {
            target.close().await;
        }
        self.changed();
        Ok(self.state().await)
    }
    async fn assert_global_change(&self) -> Result<()> {
        if !self.bindings.lock().await.bindings.is_empty() || self.busy(None).await {
            return Err(ApiError::new(
                409,
                "请先结束电脑操作并释放已分配画面，再切换连接。",
            ));
        }
        Ok(())
    }
    pub async fn busy(&self, agent_id: Option<&str>) -> bool {
        let task_scope = if agent_id.is_some() && self.uses_shared_screen().await {
            None
        } else {
            agent_id
        };
        if self.tasks.busy(task_scope) {
            return true;
        }
        let jobs: Vec<_> = self.jobs.lock().await.values().cloned().collect();
        for job in jobs {
            if agent_id.is_none_or(|id| job.context.agent_id.as_deref() == Some(id))
                && !*job.finished.borrow()
            {
                return true;
            }
        }
        if self.takeovers.lock().await.values().any(|l| {
            l.expires_at > crate::db::now()
                && agent_id.is_none_or(|a| l.agent_id.as_deref() == Some(a))
        }) {
            return true;
        }
        let targets: Vec<_> = self.screen_targets.lock().await.values().cloned().collect();
        if targets.iter().any(|t| {
            agent_id.is_none_or(|a| t.binding.as_ref().is_some_and(|b| b.agent_id == a))
                && t.active_count() > 0
        }) {
            return true;
        }
        agent_id.is_none()
            && self
                .target
                .lock()
                .await
                .as_ref()
                .is_some_and(|t| t.active_count() > 0)
    }
    pub(crate) fn changed(&self) {
        self.store.emit("update", json!({}));
    }
    pub async fn deletion_guard(&self, agent: &str) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        let guard = self.management.lock().await;
        let journal = self.bindings.lock().await;
        if journal.bindings.iter().any(|b| b.agent_id == agent)
            || journal
                .operations
                .iter()
                .any(|o| o.agent_id == agent && o.status != "complete")
        {
            return Err(ApiError::new(
                409,
                "请先释放此 Bot 的独立画面，再删除 Bot。",
            ));
        }
        drop(journal);
        if self.busy(Some(agent)).await {
            return Err(ApiError::new(409, "请先结束此 Bot 的电脑任务。"));
        }
        Ok(guard)
    }
    pub(crate) async fn saved_remote(&self) -> Result<SavedRemote> {
        self.saved
            .lock()
            .await
            .as_ref()
            .filter(|s| s.selection == "remote")
            .and_then(|s| s.remote.clone())
            .ok_or_else(|| ApiError::new(409, "请先连接工作电脑。"))
    }
    pub(crate) async fn configured_remote(&self) -> Option<SavedRemote> {
        self.saved
            .lock()
            .await
            .as_ref()
            .and_then(|s| s.remote.clone())
    }
    pub async fn close(self: &Arc<Self>) {
        self.closed.store(true, Ordering::Release);
        self.cloud.close().await;
        let _ =
            super::approvals::cancel_scope(self, None, "服务正在关闭，原电脑操作已取消。").await;
        for job in self.jobs.lock().await.values() {
            job.stopped.send_replace(true);
        }
        let mut targets: Vec<_> = self.screen_targets.lock().await.values().cloned().collect();
        if let Some(target) = self.target.lock().await.clone() {
            targets.push(target);
        }
        for target in targets {
            target.close().await;
        }
        if let Some(mut local) = self.local.lock().await.take() {
            let _ = local.close().await;
        }
        self.jobs.lock().await.clear();
    }
    pub(crate) async fn bound_target(
        self: &Arc<Self>,
        binding: &ScreenBinding,
        authorize: Authority,
    ) -> Result<Arc<Target>> {
        if let Some(target) = self
            .screen_targets
            .lock()
            .await
            .get(&binding.agent_id)
            .filter(|t| {
                t.binding
                    .as_ref()
                    .is_some_and(|b| b.assignment_revision == binding.assignment_revision)
            })
            .cloned()
        {
            target.active()?;
            return Ok(target);
        }
        let saved = self.saved_remote().await?;
        let probe = self.cloud.guard(&saved.url);
        if let Some(probe) = &probe {
            probe().await?;
        }
        let target = Target::discover(
            &saved.url,
            &saved.token,
            &self.store.workspace_id,
            self.origin.as_deref(),
            Some(binding.clone()),
            Some(&saved),
            authorize,
        )
        .await?;
        target.set_probe(probe).await;
        self.screen_targets
            .lock()
            .await
            .insert(binding.agent_id.clone(), target.clone());
        Ok(target)
    }
}
pub fn user_authority(state: &State, actor: &WorkspaceAccess) -> Authority {
    let state = state.clone();
    let actor = actor.clone();
    Arc::new(move || {
        let state = state.clone();
        let actor = actor.clone();
        Box::pin(async move { actor.authorize(&state).await })
    })
}
