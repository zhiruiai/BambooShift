use super::{approvals::Job, controller::Controller};
use std::sync::Arc;

pub(super) async fn completed(controller: &Controller, id: &str, job: &Arc<Job>) {
    if !*job.finished.borrow() || job.target.is_blocked() {
        return;
    }
    let mut jobs = controller.jobs.lock().await;
    if jobs
        .get(id)
        .is_some_and(|current| Arc::ptr_eq(current, job))
    {
        jobs.remove(id);
    }
}

pub(super) async fn recovered(controller: &Controller, agent: &str) {
    controller.jobs.lock().await.retain(|_, job| {
        !*job.finished.borrow()
            || if agent == "default" {
                // A local shared target has no per-Bot screen binding. Recovery
                // retires its finished jobs regardless of the requesting Bot.
                job.target.binding.is_some()
            } else {
                job.context.agent_id.as_deref().unwrap_or("default") != agent
            }
    });
}
