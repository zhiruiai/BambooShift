use super::*;
use std::time::Duration;

async fn wait_status(f: &Fixture, path: &str, expected: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let (status, value) = f.request("GET", path, None, false, Some(&f.owner)).await;
            assert_eq!(status, 200, "{value}");
            if value["status"] == expected {
                return value;
            }
            assert!(
                !["error", "cancelled", "expired"]
                    .contains(&value["status"].as_str().unwrap_or("")),
                "{value}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("The saved OAuth operation did not reach its expected status")
}

#[tokio::test]
async fn abandoned_start_is_discoverable_and_concurrent_start_cannot_replace_it() {
    let (f, server, connection) = fixture().await;
    server
        .remote
        .hold_registration
        .store(true, Ordering::SeqCst);
    let current_path = f.path(&format!(
        "/apps/{}/oauth",
        connection["id"].as_str().unwrap()
    ));
    let start_path = format!("{current_path}/start");
    let mut started = Box::pin(f.request(
        "POST",
        &start_path,
        Some(json!({"expectedRevision":connection["revision"]})),
        false,
        Some(&f.owner),
    ));
    tokio::select! {
        result = &mut started => panic!("Start finished before the held provider response: {result:?}"),
        () = async {
            tokio::time::timeout(Duration::from_secs(12), async {
                while server.remote.registrations.lock().await.is_empty() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }).await.unwrap();
        } => {}
    }
    drop(started);
    let preparing = wait_status(&f, &current_path, "preparing").await;
    let (status, repeat) = f
        .request(
            "POST",
            &start_path,
            Some(json!({"expectedRevision":preparing["connectionRevision"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409, "{repeat}");
    server
        .remote
        .hold_registration
        .store(false, Ordering::SeqCst);
    let pending = wait_status(&f, &current_path, "pending").await;
    assert_eq!(pending["id"], preparing["id"]);
    assert!(pending["launchPath"].is_string());
    assert_eq!(server.remote.registrations.lock().await.len(), 1);
    f.close().await;
}

async fn callback_ready(f: &Fixture, connection: &Value) -> String {
    let flow = start(f, connection).await;
    let path = flowpath(f, connection, &flow);
    let original = format!("openbot_account={}", f.owner_token);
    let (status, headers, opened) = raw(
        f,
        "POST",
        &(path.clone() + "/begin"),
        Some(json!({})),
        &original,
        Some(&f.owner),
        false,
    )
    .await;
    assert_eq!(status, 200, "{opened}");
    let nonce = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let callback = callback_url(opened["authorizationUrl"].as_str().unwrap()).await;
    assert_eq!(
        raw(f, "GET", &callback, None, nonce, None, true).await.0,
        303
    );
    path
}

#[tokio::test]
async fn abandoned_finish_can_be_recovered_without_a_second_token_exchange() {
    let (f, server, connection) = fixture().await;
    let path = callback_ready(&f, &connection).await;
    let finish_path = format!("{path}/finish");
    server.remote.hold_exchange.store(true, Ordering::SeqCst);
    let mut finish =
        Box::pin(f.request("POST", &finish_path, Some(json!({})), false, Some(&f.owner)));
    tokio::select! {
        result = &mut finish => panic!("Finish settled before provider response: {result:?}"),
        () = wait_until(|| server.remote.exchanges.load(Ordering::SeqCst) == 1) => {}
    }
    drop(finish);
    assert_eq!(
        wait_status(&f, &path, "exchanging").await["connectionId"],
        connection["id"]
    );
    assert_eq!(
        f.request("POST", &finish_path, Some(json!({})), false, Some(&f.owner))
            .await
            .0,
        409
    );
    server.remote.hold_exchange.store(false, Ordering::SeqCst);
    let completed = wait_status(&f, &path, "complete").await;
    let repeat = f
        .request("POST", &finish_path, Some(json!({})), false, Some(&f.owner))
        .await;
    assert_eq!(repeat, (200, completed));
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let data = f.bootstrap().await;
            if data["apps"][0]["status"] == "connected" {
                assert_eq!(data["apps"][0]["id"], connection["id"]);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(server.remote.exchanges.load(Ordering::SeqCst), 1);
    f.close().await;
}

#[tokio::test]
async fn cancellation_still_fences_a_late_provider_exchange_result() {
    let (f, server, connection) = fixture().await;
    let path = callback_ready(&f, &connection).await;
    let finish_path = format!("{path}/finish");
    server.remote.hold_exchange.store(true, Ordering::SeqCst);
    let mut finish =
        Box::pin(f.request("POST", &finish_path, Some(json!({})), false, Some(&f.owner)));
    tokio::select! {
        result = &mut finish => panic!("Finish settled before provider response: {result:?}"),
        () = wait_until(|| server.remote.exchanges.load(Ordering::SeqCst) == 1) => {}
    }
    let cancelled = f
        .request(
            "POST",
            &format!("{path}/cancel"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(cancelled.0, 200);
    assert_eq!(cancelled.1["status"], "cancelled");
    server.remote.hold_exchange.store(false, Ordering::SeqCst);
    let late = finish.await;
    assert_eq!(late, cancelled);
    let data = f.bootstrap().await;
    assert_eq!(data["apps"][0]["status"], "needs_auth");
    assert_eq!(data["apps"][0]["hasCredential"], false);
    assert_eq!(server.remote.exchanges.load(Ordering::SeqCst), 1);
    f.close().await;
}
