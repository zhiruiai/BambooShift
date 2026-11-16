mod computer_support;
mod workspace_support;
use computer_support::*;
use serde_json::{Value, json};
use workspace_support::Fixture;

async fn mode(f: &Fixture, value: &str, revision: &Value) -> Value {
    let (status, result) = f
        .request(
            "POST",
            &f.path("/computer/authorization"),
            Some(json!({"mode":value,"expectedTargetRevision":revision})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["mode"], value);
    result
}
async fn action(f: &Fixture, member: bool) -> Value {
    let (status, result) = f
        .request(
            "POST",
            &f.path("/computer/actions"),
            Some(json!({"type":"browser_click","selector":"#synthetic"})),
            member,
            Some(if member { &f.member } else { &f.owner }),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    result
}
#[tokio::test]
async fn full_grant_runs_existing_and_future_actions_and_revoke_restores_approval() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    let connection = connect(&f, &s.worker).await;
    let pending = action(&f, false).await;
    assert_eq!(pending["status"], "pending");
    let member_pending = action(&f, true).await;
    let revision = &connection["targetRevision"];
    let (code, _) = f
        .request(
            "POST",
            &f.path("/computer/authorization"),
            Some(json!({"mode":"full","expectedTargetRevision":revision})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(code, 403);
    let (code, _) = f
        .request(
            "POST",
            &f.path("/computer/authorization"),
            Some(json!({"mode":"full","expectedTargetRevision":uuid::Uuid::new_v4().to_string()})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 409);
    mode(&f, "full", revision).await;
    let done = settled(&f, pending["id"].as_str().unwrap()).await;
    assert_eq!(done["status"], "done", "{done}");
    assert_eq!(done["authorization"]["mode"], "full");
    let direct = action(&f, false).await;
    assert_eq!(direct["status"], "done", "{direct}");
    assert_eq!(direct["authorization"]["mode"], "full");
    let (_, all) = f
        .request("GET", &f.path("/computer/actions"), None, false, None)
        .await;
    assert_eq!(
        all.as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == member_pending["id"])
            .unwrap()["status"],
        "pending"
    );
    let (_, view) = f
        .request("GET", &f.path("/computer/status"), None, true, None)
        .await;
    assert_eq!(view["authorization"]["mode"], "confirm");
    assert_eq!(view["authorization"]["canManage"], false);
    mode(&f, "confirm", revision).await;
    assert_eq!(action(&f, false).await["status"], "pending");
    f.state.close().await;
}
#[tokio::test]
async fn persistent_grant_is_bound_to_identity_and_current_owner() {
    let mut f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    let connection = connect(&f, &s.worker).await;
    mode(&f, "full", &connection["targetRevision"]).await;
    f.state.close().await;
    f.state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        f.directory.path(),
    ))
    .await
    .unwrap();
    let (_, status) = f
        .request("GET", &f.path("/computer/status"), None, false, None)
        .await;
    assert_eq!(status["authorization"]["mode"], "full", "{status}");
    assert_eq!(action(&f, false).await["status"], "done");
    sqlx::query("UPDATE memberships SET role='member' WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(action(&f, false).await["status"], "pending");
    sqlx::query("UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    f.state.close().await;
    f.state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        f.directory.path(),
    ))
    .await
    .unwrap();
    let replacement = Server::start(&f.workspace).await;
    connect(&f, &replacement.worker).await;
    let (_, status) = f
        .request("GET", &f.path("/computer/status"), None, false, None)
        .await;
    assert_eq!(status["authorization"]["mode"], "confirm", "{status}");
    assert_eq!(action(&f, false).await["status"], "pending");
    f.state.close().await;
}
#[tokio::test]
async fn full_grant_still_validates_native_app_binding_and_payload() {
    use std::sync::atomic::Ordering;
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    s.worker.mac_app_launch.store(true, Ordering::SeqCst);
    let connection = connect(&f, &s.worker).await;
    mode(&f, "full", &connection["targetRevision"]).await;
    let payload = json!({"type":"desktop_ax_open","bundleId":"com.apple.calculator"});
    let (code, result) = f
        .request(
            "POST",
            &f.path("/computer/actions"),
            Some(payload.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{result}");
    assert_eq!(result["status"], "done", "{result}");
    assert_eq!(result["target"]["bundleId"], "com.apple.calculator");
    assert_eq!(result["authorization"]["mode"], "full");
    let mut forged = payload;
    forged["identity"] = json!(APP_LAUNCH_IDENTITY);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/computer/actions"),
            Some(forged),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/computer/actions"),
            Some(json!({"type":"local_skill_script","path":"scripts/fake.py"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    f.state.close().await;
}

#[tokio::test]
async fn revoke_stops_automatic_execution_and_blocks_queued_mutations() {
    use std::{sync::Arc, time::Duration};
    let f = Arc::new(Fixture::new().await);
    let s = Server::start(&f.workspace).await;
    let connection = connect(&f, &s.worker).await;
    let granted = mode(&f, "full", &connection["targetRevision"]).await;
    // A retried grant must preserve its identity instead of cancelling in-flight work.
    assert_eq!(
        mode(&f, "full", &connection["targetRevision"]).await["grantedAt"],
        granted["grantedAt"]
    );
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *s.worker.execute_gate.lock().await = Some(gate.clone());
    let send = |f: Arc<Fixture>| tokio::spawn(async move { action(&f, false).await });
    let running = send(f.clone());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if s.worker
                .calls
                .lock()
                .await
                .iter()
                .any(|(path, _)| path == "/execute")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let queued_fixture = f.clone();
    let queued = tokio::spawn(async move {
        queued_fixture
            .request(
                "POST",
                &queued_fixture.path("/computer/actions"),
                Some(json!({"type":"browser_click","selector":"#queued"})),
                false,
                Some(&queued_fixture.owner),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    tokio::time::timeout(
        Duration::from_secs(1),
        mode(&f, "confirm", &connection["targetRevision"]),
    )
    .await
    .expect("revoking full authorization must not wait behind the worker");
    let first = tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first["status"], "error", "{first}");
    let second = tokio::time::timeout(Duration::from_secs(10), queued)
        .await
        .unwrap()
        .unwrap();
    assert!(
        second.0 == 409 || (second.0 == 200 && second.1["status"] == "pending"),
        "{second:?}"
    );
    assert_eq!(
        s.worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(path, _)| path == "/execute")
            .count(),
        1
    );
    gate.add_permits(1);
    f.state.close().await;
}

#[tokio::test]
async fn granting_pending_actions_returns_before_long_running_command_and_can_be_revoked() {
    use std::{sync::Arc, time::Duration};
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    let connection = connect(&f, &s.worker).await;
    let first = action(&f, false).await;
    let second = action(&f, false).await;
    assert_eq!(first["status"], "pending");
    assert_eq!(second["status"], "pending");
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *s.worker.execute_gate.lock().await = Some(gate.clone());
    tokio::time::timeout(
        Duration::from_secs(1),
        mode(&f, "full", &connection["targetRevision"]),
    )
    .await
    .expect("saving full authorization must not wait for pending commands");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if s.worker
                .calls
                .lock()
                .await
                .iter()
                .any(|(path, _)| path == "/execute")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        mode(&f, "confirm", &connection["targetRevision"]),
    )
    .await
    .expect("revoking must not wait behind a worker command");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        s.worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(path, _)| path == "/execute")
            .count(),
        1
    );
    let (_, receipts) = f
        .request("GET", &f.path("/computer/actions"), None, false, None)
        .await;
    assert!(
        receipts
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["status"] != "running"),
        "{receipts}"
    );
    gate.add_permits(1);
    f.state.close().await;
}
