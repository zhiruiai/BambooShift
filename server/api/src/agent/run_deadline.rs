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
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn expiry_cancels_authority_but_waits_for_the_inflight_cleanup() {
        let deadline = RunDeadline::new("user");
        deadline
            .deadline
            .set(Instant::now() + Duration::from_millis(20))
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let observed = cancelled.clone();
        let (commands, mut receiver) = mpsc::channel(1);
        let (entered, cleanup_started) = oneshot::channel();
        let (release, cleanup) = oneshot::channel();
        let task = tokio::spawn(async move {
            deadline
                .enforce(&cancelled, &commands, "synthetic-root", async {
                    assert_eq!(receiver.recv().await.unwrap()["type"], "abort");
                    assert!(cancelled.load(Ordering::Acquire));
                    entered.send(()).unwrap();
                    cleanup.await.unwrap();
                    Ok(())
                })
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), cleanup_started)
            .await
            .unwrap()
            .unwrap();
        assert!(observed.load(Ordering::Acquire));
        assert!(
            !task.is_finished(),
            "Unknown cleanup must not settle the root task"
        );
        release.send(()).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err().status.as_u16(), 504);
    }

    #[tokio::test]
    async fn success_keeps_the_same_deadline_and_existing_limits() {
        for (kind, seconds) in [("user", 1800), ("memory_import", 120), ("webhook", 60)] {
            let budget = RunDeadline::new(kind);
            let first = budget.instant();
            assert_eq!(first, budget.instant());
            assert!(budget.remaining_ms().unwrap() <= seconds * 1000);
            let cancelled = AtomicBool::new(false);
            let (commands, mut receiver) = mpsc::channel(1);
            assert_eq!(
                budget
                    .enforce(&cancelled, &commands, "root", async { Ok(7) })
                    .await
                    .unwrap(),
                7
            );
            assert!(!cancelled.load(Ordering::Acquire));
            assert!(receiver.try_recv().is_err());
        }
    }
}
