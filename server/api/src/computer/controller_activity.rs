use super::{controller::Controller, transport::Target};

impl Controller {
    pub async fn busy(&self, agent_id: Option<&str>) -> bool {
        self.busy_with_observers(agent_id, true).await
    }

    // Native replay holds management. Passive observations may finish through
    // the worker queue before /surface, including tracked screenshot cleanup.
    // All other lifecycle callers retain the stronger all-requests idle gate.
    pub(crate) async fn busy_for_surface_replay(&self) -> bool {
        self.busy_with_observers(None, false).await
    }

    async fn busy_with_observers(&self, agent_id: Option<&str>, observers: bool) -> bool {
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
        if self.takeovers.lock().await.values().any(|lease| {
            lease.expires_at > crate::db::now()
                && agent_id.is_none_or(|agent| lease.agent_id.as_deref() == Some(agent))
        }) {
            return true;
        }
        let active = if observers {
            Target::active_count
        } else {
            Target::active_control_count
        };
        let targets: Vec<_> = self.screen_targets.lock().await.values().cloned().collect();
        if targets.iter().any(|target| {
            agent_id
                .is_none_or(|agent| target.binding.as_ref().is_some_and(|b| b.agent_id == agent))
                && active(target) > 0
        }) {
            return true;
        }
        agent_id.is_none()
            && self
                .target
                .lock()
                .await
                .as_ref()
                .is_some_and(|target| active(target) > 0)
    }
}
