use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    future::Future,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::mpsc, time::Instant};

/// One monotonic deadline for a root task and all of its delegated descendants.
pub(super) struct RunDeadline {
    limit: Duration,
    deadline: OnceLock<Instant>,
}

impl RunDeadline {
    pub fn new(kind: &str) -> Self {
        Self {
            limit: Duration::from_secs(match kind {
                "memory_import" => 120,
                "primary_checkin" | "webhook" => 60,
                _ => 1800,
            }),
            deadline: OnceLock::new(),
        }
    }

    pub fn instant(&self) -> Instant {
        *self.deadline.get_or_init(|| Instant::now() + self.limit)
    }

    pub fn remaining_ms(&self) -> Result<u64> {
        let remaining = self
            .instant()
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        if remaining == 0 {
            return Err(expired());
        }
        // Never extend a delegated run beyond its parent's remaining budget.
        Ok(remaining)
    }

    pub async fn enforce<T>(
        &self,
        cancelled: &AtomicBool,
        commands: &mpsc::Sender<Value>,
        run_id: &str,
        operation: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let deadline = self.instant();
        tokio::pin!(operation);
        tokio::select! {
            output = &mut operation => {
                if Instant::now() >= deadline {
                    cancelled.store(true, Ordering::Release);
                    if output.is_ok() { return Err(expired()); }
                }
                output
            },
            _ = tokio::time::sleep_until(deadline) => {
                cancelled.store(true, Ordering::Release);
                let _ = commands.try_send(json!({"type":"abort","runId":run_id}));
                // Do not drop a mutating tool future: existing cancellation and cleanup
                // must establish its outcome before the root task can become idle.
                let _ = operation.await;
                Err(expired())
            },
        }
    }
}

pub(super) fn expired() -> ApiError {
    ApiError::new(504, "任务执行时间过长，已停止。")
}

#[cfg(test)]
#[path = "../../tests/unit/agent/run_deadline.rs"]
mod tests;
