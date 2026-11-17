use super::Fixture;
use openbot_backend::computer::transport::{Authority, Request};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn delayed_health_poll_does_not_block_full_grant_or_explicit_native_restore() {
    for first_grant in [true, false] {
        let f = Fixture::new().await;
        if !first_grant {
            std::fs::write(&f.permission, "denied").unwrap();
            f.grant("full").await;
            std::fs::remove_file(&f.permission).unwrap();
        }
        let status = f.ok("/status", None).await;
        assert_eq!(status["surface"], "browser");
        let store = f
            .state
            .workspace
            .get(&f.workspace, &f.workspace)
            .await
            .unwrap();
        let controller = f.state.computer.get(&f.state, store).await.unwrap();
        let allowed: Authority = Arc::new(|| Box::pin(async { Ok(()) }));
        let target = controller.target(allowed).await.unwrap();
        let once = Arc::new(AtomicBool::new(true));
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let (flag, started, gate) = (once.clone(), entered.clone(), release.clone());
        target
            .set_probe(Some(Arc::new(move || {
                let (flag, started, gate) = (flag.clone(), started.clone(), gate.clone());
                Box::pin(async move {
                    if flag.swap(false, Ordering::SeqCst) {
                        started.add_permits(1);
                        gate.acquire().await.unwrap().forget();
                    }
                    Ok(())
                })
            })))
            .await;
        let f = Arc::new(f);
        let reader = {
            let f = f.clone();
            tokio::spawn(async move { f.call("/status", None).await })
        };
        tokio::time::timeout(Duration::from_secs(3), entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        assert!(
            controller.busy(None).await,
            "other lifecycle operations still include observations"
        );
        let mut operation = {
            let f = f.clone();
            tokio::spawn(async move {
                let path = if first_grant {
                    "/authorization"
                } else {
                    "/permissions/refresh"
                };
                let mut body = json!({"expectedTargetRevision":status["targetRevision"]});
                if first_grant {
                    body["mode"] = json!("full");
                }
                f.call(path, Some(body)).await
            })
        };
        // It must queue behind the passive probe, rather than reject refresh or
        // silently save Full without restoring the already-authorized surface.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut operation)
                .await
                .is_err()
        );
        release.add_permits(1);
        let result = tokio::time::timeout(Duration::from_secs(5), operation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status, 200, "{}", result.value);
        assert_eq!(reader.await.unwrap().status, 200);
        target.set_probe(None).await;
        f.status("accessibility", "full").await;
        f.state.close().await;
    }
}

#[tokio::test]
async fn pending_file_export_is_not_treated_as_a_passive_observer() {
    let f = Arc::new(Fixture::new().await);
    let status = f.ok("/status", None).await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let controller = f.state.computer.get(&f.state, store).await.unwrap();
    let allowed: Authority = Arc::new(|| Box::pin(async { Ok(()) }));
    let target = controller.target(allowed.clone()).await.unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let gate = Arc::new(Semaphore::new(0));
    let (started, release) = (entered.clone(), gate.clone());
    target
        .set_probe(Some(Arc::new(move || {
            let (started, release) = (started.clone(), release.clone());
            Box::pin(async move {
                started.add_permits(1);
                release.acquire().await.unwrap().forget();
                Ok(())
            })
        })))
        .await;
    let worker = target.clone();
    let export = tokio::spawn(async move {
        worker
            .request(Request::get("/files/content?path=synthetic.txt"), allowed)
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let result = f
        .call(
            "/permissions/refresh",
            Some(json!({
                "expectedTargetRevision":status["targetRevision"]
            })),
        )
        .await;
    assert_eq!(result.status, 409, "{}", result.value);
    export.abort();
    let _ = export.await;
    target.set_probe(None).await;
    f.state.close().await;
}
