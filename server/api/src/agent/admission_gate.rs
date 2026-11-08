use crate::error::{ApiError, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};
use tokio::sync::{Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
#[derive(Default)]
pub(crate) struct AdmissionGates {
    gates: Mutex<HashMap<String, Weak<RwLock<()>>>>,
}
impl AdmissionGates {
    pub async fn gate(&self, workspace: &str) -> Arc<RwLock<()>> {
        let mut gates = self.gates.lock().await;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(workspace).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(RwLock::new(()));
        gates.insert(workspace.to_owned(), Arc::downgrade(&gate));
        gate
    }
}
impl super::registry::AgentRegistry {
    pub(crate) async fn admission(&self, workspace: &str) -> Result<OwnedRwLockReadGuard<()>> {
        if self.is_closed() {
            return Err(ApiError::new(503, "执行服务正在停止。"));
        }
        Ok(self
            .admission_gates
            .gate(workspace)
            .await
            .read_owned()
            .await)
    }
    /// Reserve maintenance atomically with new root admissions and queue acceptance.
    pub async fn try_maintenance(&self, workspace: &str) -> Result<OwnedRwLockWriteGuard<()>> {
        let guard = self
            .admission_gates
            .gate(workspace)
            .await
            .try_write_owned()
            .map_err(|_| ApiError::new(409, "当前有任务正在接纳，请稍后维护。"))?;
        if self.is_closed()
            || self.workspace_busy(workspace).await
            || self.queues.workspace_pending(workspace).await
        {
            return Err(ApiError::new(409, "当前有任务或等待消息，请结束后再维护。"));
        }
        Ok(guard)
    }
}
