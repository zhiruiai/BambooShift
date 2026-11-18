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
