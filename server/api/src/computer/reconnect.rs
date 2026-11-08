use super::{
    action_store,
    controller::Controller,
    model,
    private_config::{self, SavedConnection},
    transport::{Authority, Request, Target},
};
use crate::error::{ApiError, Result};
use serde_json::Value;
use std::sync::Arc;

impl Controller {
    pub(crate) async fn retire_local(&self, current: &mut Option<Arc<Target>>) -> Result<()> {
        let local = self.local.lock().await.take();
        if let Some(mut local) = local {
            if let Some(previous) = current.take() {
                previous.close().await;
            }
            local.close().await?;
        }
        Ok(())
    }
    pub(crate) async fn install_remote(
        &self,
        target: Arc<Target>,
        authorize: &Authority,
    ) -> Result<()> {
        let mut current = self.target.lock().await;
        self.retire_local(&mut current).await?;
        authorize().await?;
        self.active()?;
        let saved = SavedConnection {
            version: 1,
            selection: "remote".into(),
            remote: Some(target.saved.clone()),
        };
        private_config::write(&self.store.directory, &saved)?;
        let previous = current.replace(target);
        *self.saved.lock().await = Some(saved);
        drop(current);
        if let Some(previous) = previous {
            previous.close().await;
        }
        Ok(())
    }
    pub(crate) async fn validate_default_recovery(&self, target: &Target) -> Result<()> {
        if self.tasks.blocked(None)
            && self
                .saved
                .lock()
                .await
                .as_ref()
                .and_then(|s| s.remote.as_ref())
                .is_some_and(|r| r.instance_id == target.saved.instance_id)
        {
            return Err(ApiError::new(
                409,
                "原电脑操作清理尚未确认，请先由维护人员重新启动工作电脑。",
            ));
        }
        Ok(())
    }
    pub(crate) async fn clear_default_recovery(&self) -> Result<()> {
        if self.tasks.blocked(None) {
            action_store::clear_recovery(&self.store, "default").await?;
            self.tasks.clear_blocked("default");
            super::job_retirement::recovered(self, "default").await;
        }
        Ok(())
    }
    pub async fn reconnect(self: &Arc<Self>, authorize: Authority) -> Result<Value> {
        let _guard = self.management.lock().await;
        self.active()?;
        authorize().await?;
        if self.busy(None).await {
            return Err(ApiError::new(
                409,
                "请先结束电脑操作和人工接管，再重新连接。",
            ));
        }
        let saved = self
            .configured_remote()
            .await
            .ok_or_else(|| ApiError::new(409, "没有可恢复的电脑连接。"))?;
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
            None,
            authorize.clone(),
        )
        .await?;
        if target.saved.control_origin != saved.control_origin {
            return Err(model::invalid());
        }
        target.set_probe(probe).await;
        self.validate_default_recovery(&target).await?;
        let idle = target
            .request(Request::get("/takeover/status"), authorize.clone())
            .await?
            .json()?;
        if idle["active"] != false {
            return Err(ApiError::new(409, "电脑仍在人工接管，请先结束接管。"));
        }
        authorize().await?;
        self.active()?;
        self.install_remote(target, &authorize).await?;
        let children: Vec<_> = self.screen_targets.lock().await.drain().collect();
        for (agent, child) in children {
            child.close().await;
            if child.is_blocked() {
                self.tasks.block(&agent);
            }
        }
        self.clear_default_recovery().await?;
        self.changed();
        if self
            .target
            .lock()
            .await
            .as_ref()
            .is_some_and(|t| t.is_blocked())
        {
            return Err(model::blocked());
        }
        Ok(self.state().await)
    }
}
