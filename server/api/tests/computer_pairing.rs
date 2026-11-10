mod computer_support;
mod workspace_support;

use axum::{Json, Router, response::Redirect, routing::get};
use computer_support::{Server, TOKEN, connect, prepared, seeded, settled};
use openbot_backend::computer::action_store;
use serde_json::{Value, json};
use workspace_support::Fixture;

const CHECK: &str = "/computer/connect/check";

async fn check(f: &Fixture, url: &str, token: &str) -> (u16, Value) {
    f.request(
        "POST",
        &f.path(CHECK),
        Some(json!({"url":url,"token":token})),
        false,
        Some(&f.owner),
    )
    .await
}

#[tokio::test]
async fn pairing_checks_only_worker_health_and_requires_owner_scope() {
    let f = Fixture::new().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    action_store::initialize(&store).await.unwrap();
    let action = uuid::Uuid::new_v4().to_string();
    action_store::persist(
        &store,
        &json!({"id":action,"action":{"id":action,"status":"running"},"context":{}}),
    )
    .await
    .unwrap();
    let worker = Server::start(&f.workspace).await;
    let url = &worker.worker.origin;
    for (member, expected) in [(true, Some(f.member.as_str())), (false, None)] {
        let (status, _) = f
            .request(
                "POST",
                &f.path(CHECK),
                Some(json!({"url":url,"token":TOKEN})),
                member,
                expected,
            )
            .await;
        assert_eq!(status, 403);
    }
    assert_eq!(
        f.request(
            "POST",
            &f.path(CHECK),
            Some(json!({"url":url,"token":TOKEN,"mode":"local"})),
            false,
            Some(&f.owner),
        )
        .await
        .0,
        400
    );
    assert!(worker.worker.calls.lock().await.is_empty());
    assert_eq!(
        check(&f, url, "incorrect-fixture-worker-token").await.0,
        409
    );
    assert_eq!(
        check(&f, url, TOKEN).await,
        (
            200,
            json!({"topology":"pool","browser":"perScreen","desktop":"perScreen"})
        )
    );
    assert_eq!(
        &*worker.worker.calls.lock().await,
        &[("/health".into(), Value::Null)]
    );
    let foreign = Server::start(&f.foreign).await;
    assert_eq!(check(&f, &foreign.worker.origin, TOKEN).await.0, 409);
    assert!(!store.directory.join("computer/connection.json").exists());
    assert_eq!(
        action_store::get(&store, &action).await.unwrap()["status"],
        "running"
    );
    f.close().await;
}

#[tokio::test]
async fn pairing_reports_native_surface_without_returning_worker_private_fields() {
    let f = Fixture::new().await;
    let scope = f.workspace.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let health = json!({
        "protocol":"openbot-computer-v2","instanceId":uuid::Uuid::new_v4().to_string(),
        "workspaceScopeId":scope,"name":"private-worker-fixture",
        "platform":"darwin","surface":"browser","status":"private-status-fixture",
        "capabilities":["workspace-shared-screen-v1","workspace-host-desktop-v1","browser"],
        "desktop":{"kind":"host","available":true,"authorized":false,"reason":"private-reason-fixture"},
    });
    let mut unscoped = health.clone();
    unscoped.as_object_mut().unwrap().remove("workspaceScopeId");
    unscoped["capabilities"] = json!(["browser"]);
    let router = Router::new()
        .route("/health", get(move || async { Json(health) }))
        .route("/unscoped/health", get(move || async { Json(unscoped) }))
        .route(
            "/redirect/health",
            get(|| async { Redirect::temporary("/health") }),
        );
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    assert_eq!(
        check(&f, &url, TOKEN).await,
        (
            200,
            json!({"topology":"shared","browser":"supported","desktop":"notReady"})
        )
    );
    let (status, rejected) = check(&f, &format!("{url}/unscoped"), TOKEN).await;
    assert_eq!(status, 409);
    assert_eq!(rejected["code"], "WORKER_SCOPE_REQUIRED");
    assert_eq!(check(&f, &format!("{url}/redirect"), TOKEN).await.0, 409);
    task.abort();
    f.close().await;
}

#[tokio::test]
async fn checking_another_worker_keeps_saved_target_and_pending_approval_valid() {
    let f = Fixture::new().await;
    let existing = Server::start(&f.workspace).await;
    let selected = connect(&f, &existing.worker).await;
    let data = seeded(&f).await;
    let bot = data["agents"][0]["id"].as_str().unwrap();
    prepared(&f, bot).await;
    let path = f.path(&format!("/computer/bots/{bot}/actions"));
    let (status, action) = f
        .request(
            "POST",
            &path,
            Some(json!({"type":"browser_click","selector":"#fixture"})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200, "{action}");
    assert_eq!(action["status"], "pending");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let connection = store.directory.join("computer/connection.json");
    let before = std::fs::read(&connection).unwrap();
    let candidate = Server::start(&f.workspace).await;
    assert_eq!(check(&f, &candidate.worker.origin, TOKEN).await.0, 200);
    assert_eq!(
        &*candidate.worker.calls.lock().await,
        &[("/health".into(), Value::Null)]
    );
    let controller = f.state.computer.get(&f.state, store).await.unwrap();
    assert_eq!(
        controller.state().await["targetRevision"],
        selected["targetRevision"]
    );
    assert_eq!(std::fs::read(connection).unwrap(), before);
    let id = action["id"].as_str().unwrap();
    assert_eq!(
        f.request(
            "POST",
            &format!("{path}/{id}/approve"),
            Some(json!({})),
            true,
            Some(&f.member),
        )
        .await
        .0,
        200
    );
    assert_eq!(settled(&f, id).await["status"], "done");
    f.close().await;
}
