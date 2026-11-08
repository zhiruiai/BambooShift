use super::{
    cloud_config::{self, CloudBinding},
    cloud_provider,
    controller::Controller,
    transport::{Authority, Request, Target},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, Notify};

pub struct Cloud {
    config: Option<CloudBinding>,
    invalid: bool,
    snapshot: Mutex<Value>,
    operation: Mutex<Option<String>>,
    epoch: AtomicU64,
    reads: AtomicU64,
    closed: AtomicBool,
    outstanding: AtomicUsize,
    drained: Notify,
}
impl Cloud {
    pub(crate) fn matches_worker(&self, url: &str) -> bool {
        self.config
            .as_ref()
            .is_some_and(|config| config.worker_url == url)
    }
    pub fn open(directory: &Path, workspace: &str) -> Arc<Self> {
        let result = cloud_config::read(directory, workspace);
        let invalid = result.is_err();
        let config = result.ok().flatten();
        let state = if invalid || config.is_some() {
            "unknown"
        } else {
            "unconfigured"
        };
        Arc::new(Self {
            config,
            invalid,
            snapshot: Mutex::new(json!({"state":state,"expiresAt":null,"observedAt":iso(now())})),
            operation: Mutex::new(None),
            epoch: AtomicU64::new(0),
            reads: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            outstanding: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }
    pub fn guard(self: &Arc<Self>, worker_url: &str) -> Option<Authority> {
        if !self.invalid && !self.matches_worker(worker_url) {
            return None;
        }
        let cloud = self.clone();
        Some(Arc::new(move || {
            let cloud = cloud.clone();
            Box::pin(async move {
                if cloud.invalid {
                    return Err(cloud_config::invalid());
                }
                if cloud.closed.load(Ordering::Acquire) {
                    return Err(cloud_provider::unavailable());
                }
                let value = cloud_provider::detail(cloud.config.as_ref().unwrap()).await?;
                if value["state"] != "running" {
                    return Err(
                        ApiError::new(409, "云电脑尚未运行，请由拥有者点击启动或恢复。")
                            .with_code("CLOUD_NOT_RUNNING"),
                    );
                }
                Ok(())
            })
        }))
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        loop {
            let wait = self.drained.notified();
            if self.outstanding.load(Ordering::Acquire) == 0 {
                break;
            }
            wait.await;
        }
    }
    pub fn enter(self: &Arc<Self>) -> Result<CloudRequest> {
        if self.closed.load(Ordering::Acquire) {
            return Err(cloud_provider::unavailable());
        }
        self.outstanding.fetch_add(1, Ordering::AcqRel);
        let lease = CloudRequest(self.clone());
        if self.closed.load(Ordering::Acquire) {
            return Err(cloud_provider::unavailable());
        }
        Ok(lease)
    }
    pub async fn get(&self, state: &State, controller: &Arc<Controller>) -> Value {
        let epoch = self.epoch.load(Ordering::Acquire);
        let order = self.reads.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(config) = &self.config {
            let observed = match cloud_provider::detail(config).await {
                Ok(v) => v,
                Err(e) => {
                    json!({"state":"unknown","expiresAt":null,"observedAt":iso(now()),"error":{"code":e.code,"message":e.message}})
                }
            };
            if self.epoch.load(Ordering::Acquire) == epoch
                && self.reads.load(Ordering::Acquire) == order
                && self.operation.lock().await.is_none()
            {
                *self.snapshot.lock().await = observed;
            }
        }
        self.public(state, controller).await
    }
    async fn public(&self, state: &State, controller: &Arc<Controller>) -> Value {
        let mut snapshot = self.snapshot.lock().await.clone();
        let operation = self.operation.lock().await.clone();
        let machine = controller.state().await;
        let matches = controller
            .configured_remote()
            .await
            .is_some_and(|remote| self.matches_worker(&remote.url));
        let selected = machine["executionLocation"] == "cloud";
        let connected = selected && machine["connected"] == true && snapshot["state"] == "running";
        let available = !controller.busy(None).await
            && !state
                .agent_runs
                .workspace_busy(&controller.store.workspace_id)
                .await;
        snapshot["configured"] = json!(self.config.is_some() || self.invalid);
        snapshot["operation"] = operation
            .as_ref()
            .map(|at| json!({"kind":"start","startedAt":at}))
            .unwrap_or(Value::Null);
        snapshot["worker"] =
            json!({"connected":connected,"reconnectRequired":self.config.is_some()&&!connected});
        snapshot["canStart"] = json!(
            self.config.is_some()
                && operation.is_none()
                && !self.closed.load(Ordering::Acquire)
                && matches
                && available
                && matches!(snapshot["state"].as_str(), Some("running" | "paused"))
        );
        if let Some(config) = &self.config {
            snapshot["provider"] = json!("cubesandbox");
            snapshot["name"] = json!(config.name);
        }
        if self.invalid {
            snapshot["error"] = json!({"code":"CLOUD_CONFIG_INVALID","message":"云电脑私有配置不可用，请联系空间管理员。"});
        }
        if !available {
            snapshot["notice"] = json!("当前有任务、电脑请求或接管尚未结束，请稍后刷新。");
        }
        snapshot
    }
    pub async fn start(
        self: &Arc<Self>,
        state: &State,
        controller: &Arc<Controller>,
        authorize: Authority,
    ) -> Result<Value> {
        let cloud = self.clone();
        let original = authorize;
        let authorize: Authority = Arc::new(move || {
            let cloud = cloud.clone();
            let original = original.clone();
            Box::pin(async move {
                if cloud.closed.load(Ordering::Acquire) {
                    return Err(cloud_provider::unavailable());
                }
                original().await
            })
        });
        let _guard = controller.management.lock().await;
        controller.active()?;
        authorize().await?;
        let config = self.config.as_ref().ok_or_else(cloud_config::invalid)?;
        if self.invalid
            || self.closed.load(Ordering::Acquire)
            || self.operation.lock().await.is_some()
        {
            return Err(cloud_provider::unavailable());
        }
        // The agent registry reservation is acquired by the HTTP caller before entering here.
        if controller.busy(None).await {
            return Err(ApiError::new(409, "请先结束当前任务、电脑操作和人工接管。"));
        }
        let saved = controller
            .configured_remote()
            .await
            .ok_or_else(|| ApiError::new(409, "请先保存对应的工作电脑连接。"))?;
        if saved.url != config.worker_url {
            return Err(ApiError::new(409, "请先保存对应的工作电脑连接。"));
        }
        self.epoch.fetch_add(1, Ordering::AcqRel);
        *self.operation.lock().await = Some(iso(now()));
        controller.changed();
        let was_selected = controller.state().await["executionLocation"] == "cloud";
        let result = self
            .start_inner(config, controller, &saved, authorize)
            .await;
        if let Err(error) = &result {
            if was_selected {
                if let Some(target) = controller.target.lock().await.as_ref() {
                    target.poison();
                }
                for target in controller.screen_targets.lock().await.values() {
                    target.poison();
                }
            }
            let mut value = self.snapshot.lock().await;
            value["state"] = json!("unknown");
            value["expiresAt"] = Value::Null;
            value["error"] = json!({"code":error.code,"message":error.message});
            value["notice"] = json!("启动请求可能已发送，请刷新状态确认；不会自动重试。");
        }
        *self.operation.lock().await = None;
        self.epoch.fetch_add(1, Ordering::AcqRel);
        controller.changed();
        result?;
        Ok(self.public(state, controller).await)
    }
    async fn start_inner(
        &self,
        config: &CloudBinding,
        controller: &Arc<Controller>,
        saved: &super::model::SavedRemote,
        authorize: Authority,
    ) -> Result<()> {
        let before = cloud_provider::detail(config).await?;
        if !matches!(before["state"].as_str(), Some("running" | "paused")) {
            return Err(ApiError::new(409, "云电脑状态正在变化，请稍后刷新。"));
        }
        if before["state"] == "running" {
            let target = Target::discover(
                &saved.url,
                &saved.token,
                &controller.store.workspace_id,
                controller.origin.as_deref(),
                None,
                None,
                authorize.clone(),
            )
            .await?;
            if target.saved.control_origin != saved.control_origin {
                return Err(super::model::invalid());
            }
            let takeover = target
                .request(Request::get("/takeover/status"), authorize.clone())
                .await?
                .json()?;
            if takeover["active"] != false {
                return Err(ApiError::new(409, "云电脑仍在人工接管，请结束接管后重试。"));
            }
        }
        authorize().await?;
        let connected = cloud_provider::request(config, true).await?;
        authorize().await?;
        cloud_config::merge_credentials(config, &connected)?;
        let mut observed = cloud_provider::detail(config).await?;
        if observed["state"] != "running" {
            return Err(ApiError::new(502, "云电脑尚未进入运行状态，请刷新确认。"));
        }
        let target = Target::discover(
            &saved.url,
            &saved.token,
            &controller.store.workspace_id,
            controller.origin.as_deref(),
            None,
            None,
            authorize.clone(),
        )
        .await?;
        if target.saved.control_origin != saved.control_origin {
            return Err(super::model::invalid());
        }
        let takeover = target
            .request(Request::get("/takeover/status"), authorize.clone())
            .await?
            .json()?;
        if takeover["active"] != false {
            return Err(ApiError::new(409, "云电脑仍在人工接管，请先结束接管。"));
        }
        authorize().await?;
        controller.active()?;
        controller.validate_default_recovery(&target).await?;
        target.set_probe(controller.cloud.guard(&saved.url)).await;
        controller.install_remote(target, &authorize).await?;
        let children: Vec<_> = controller
            .screen_targets
            .lock()
            .await
            .drain()
            .map(|(_, v)| v)
            .collect();
        for child in children {
            child.close().await;
        }
        controller.clear_default_recovery().await?;
        observed["notice"] =
            json!("云电脑已连接；已申请至少两小时，原有更晚期限会保留。不会自动续期。");
        *self.snapshot.lock().await = observed;
        Ok(())
    }
}
pub struct CloudRequest(Arc<Cloud>);
impl Drop for CloudRequest {
    fn drop(&mut self) {
        self.0.outstanding.fetch_sub(1, Ordering::AcqRel);
        self.0.drained.notify_waiters();
    }
}
