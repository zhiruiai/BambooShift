mod computer_support;
mod workspace_support;
use axum::{
    Json, Router,
    extract::{Request, State},
    response::{IntoResponse, Response},
};
use computer_support::*;
use openbot_backend::computer::{
    model,
    private_config::{self, SavedConnection},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Mutex;
use workspace_support::Fixture;

struct Provider {
    phase: Mutex<String>,
    posts: AtomicUsize,
    token: Mutex<Option<String>>,
}
async fn endpoint(State(provider): State<Arc<Provider>>, request: Request) -> Response {
    if request.uri().path() == "/sandboxes/synthetic-box/connect"
        && request.method() == axum::http::Method::POST
    {
        let bytes = axum::body::to_bytes(request.into_body(), 4096)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body, json!({"timeout":7200}));
        provider.posts.fetch_add(1, Ordering::SeqCst);
        *provider.phase.lock().await = "running".into();
        let mut value = json!({"sandboxID":"synthetic-box","templateID":"synthetic-template","state":"running","domain":"synthetic.example.test"});
        if let Some(token) = provider.token.lock().await.clone() {
            value["trafficAccessToken"] = json!(token);
        }
        return Json(value).into_response();
    }
    if request.uri().path() == "/sandboxes/synthetic-box"
        && request.method() == axum::http::Method::GET
    {
        return Json(json!({"sandboxID":"synthetic-box","templateID":"synthetic-template","state":provider.phase.lock().await.clone(),"endAt":"2030-01-01T00:00:00Z"})).into_response();
    }
    axum::http::StatusCode::NOT_FOUND.into_response()
}
async fn setup() -> (Fixture, Server, Arc<Provider>, tokio::task::JoinHandle<()>) {
    let f = Fixture::new().await;
    let worker = Server::start(&f.workspace).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let provider = Arc::new(Provider {
        phase: Mutex::new("paused".into()),
        posts: AtomicUsize::new(0),
        token: Mutex::new(None),
    });
    let app = Router::new()
        .fallback(endpoint)
        .with_state(provider.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    private_config::write(
        &store.directory,
        &SavedConnection {
            version: 1,
            selection: "remote".into(),
            remote: Some(model::SavedRemote {
                url: worker.worker.origin.clone(),
                token: TOKEN.into(),
                instance_id: worker.worker.instance.clone(),
                control_origin: None,
                name: "Fixture computer".into(),
                platform: "linux".into(),
                capabilities: vec![model::CLEANUP.into(), model::SCREEN_POOL.into()],
            }),
        },
    )
    .unwrap();
    let bridge = store.directory.join("computer/bridge.json");
    private_config::atomic_private(&bridge,json!({"sandboxID":"synthetic-box","domain":"synthetic.example.test","trafficAccessToken":"synthetic-original-traffic-token"}).to_string().as_bytes()).unwrap();
    private_config::atomic_private(&store.directory.join("computer/cloud.json"),json!({"version":1,"provider":"cubesandbox","workspaceId":f.workspace,"name":"Fixture cloud","apiBaseUrl":origin,"sandboxId":"synthetic-box","templateId":"synthetic-template","workerUrl":worker.worker.origin,"autoResume":false,"bridgeConfigPath":bridge}).to_string().as_bytes()).unwrap();
    (f, worker, provider, task)
}
#[tokio::test]
async fn paused_cloud_never_autoresumes_and_explicit_owner_start_preserves_omitted_credentials() {
    let (f, worker, provider, task) = setup().await;
    let (status, cloud) = f
        .request(
            "GET",
            &f.path("/cloud-computer"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{cloud}");
    assert_eq!(cloud["state"], "paused");
    assert_eq!(cloud["canStart"], true);
    assert!(!cloud.to_string().contains("synthetic-box"));
    let (_, machine) = f
        .request(
            "GET",
            &f.path("/computer/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(machine["connected"], false);
    assert!(worker.worker.calls.lock().await.is_empty());
    assert_eq!(provider.posts.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/cloud-computer/start"),
            Some(json!({})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    let (status, started) = f
        .request(
            "POST",
            &f.path("/cloud-computer/start"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["worker"]["connected"], true);
    assert_eq!(provider.posts.load(Ordering::SeqCst), 1);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let saved: Value = serde_json::from_slice(
        &std::fs::read(store.directory.join("computer/bridge.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        saved["trafficAccessToken"],
        "synthetic-original-traffic-token"
    );
    f.state.close().await;
    task.abort();
}
#[tokio::test]
async fn explicit_cloud_refresh_updates_only_fixed_private_bridge_and_rejects_concurrent_maintenance()
 {
    let (f, _worker, provider, task) = setup().await;
    *provider.token.lock().await = Some("synthetic-rotated-traffic-token".into());
    let guard = f
        .state
        .agent_runs
        .try_maintenance(&f.workspace)
        .await
        .unwrap();
    assert_eq!(
        f.request(
            "POST",
            &f.path("/cloud-computer/start"),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    assert_eq!(provider.posts.load(Ordering::SeqCst), 0);
    drop(guard);
    let (status, value) = f
        .request(
            "POST",
            &f.path("/cloud-computer/start"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    assert!(!value.to_string().contains("synthetic-rotated"));
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let saved: Value = serde_json::from_slice(
        &std::fs::read(store.directory.join("computer/bridge.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        saved["trafficAccessToken"],
        "synthetic-rotated-traffic-token"
    );
    f.state.close().await;
    task.abort();
}

#[tokio::test]
async fn switching_to_local_preserves_cloud_configuration_and_failed_cloud_start_keeps_local() {
    let (f, _worker, provider, task) = setup().await;
    let (code, local) = f
        .request(
            "POST",
            &f.path("/computer/connect"),
            Some(json!({"mode":"local"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{local}");
    assert_eq!(local["executionLocation"], "server");
    assert_eq!(local["savedRemote"]["name"], "Fixture computer");
    assert!(local["targetRevision"].is_string());
    let (_, cloud) = f
        .request(
            "GET",
            &f.path("/cloud-computer"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(cloud["state"], "paused");
    assert_eq!(cloud["worker"]["connected"], false);
    assert_eq!(cloud["canStart"], true);
    assert_eq!(provider.posts.load(Ordering::SeqCst), 0);

    *provider.phase.lock().await = "pausing".into();
    let (code, _) = f
        .request(
            "POST",
            &f.path("/cloud-computer/start"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 409);
    let (_, current) = f
        .request(
            "GET",
            &f.path("/computer/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(current["connected"], true);
    assert_eq!(current["targetRevision"], local["targetRevision"]);

    *provider.phase.lock().await = "paused".into();
    let (code, cloud) = f
        .request(
            "POST",
            &f.path("/cloud-computer/start"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{cloud}");
    assert_eq!(cloud["worker"]["connected"], true);
    assert_eq!(provider.posts.load(Ordering::SeqCst), 1);
    let (_, current) = f
        .request(
            "GET",
            &f.path("/computer/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(current["executionLocation"], "cloud");
    assert_ne!(current["targetRevision"], local["targetRevision"]);
    let (code, rejected) = f
        .request(
            "POST",
            &f.path("/computer/actions"),
            Some(json!({"type":"list_files","path":".","expectedTargetRevision":local["targetRevision"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 409);
    assert_eq!(rejected["code"], "COMPUTER_TARGET_CHANGED");
    f.state.close().await;
    task.abort();
}

#[tokio::test]
async fn switching_to_local_cannot_clear_unconfirmed_remote_cleanup() {
    let (f, _worker, provider, task) = setup().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    openbot_backend::computer::action_store::initialize(&store)
        .await
        .unwrap();
    openbot_backend::computer::action_store::mark_recovery(&store, "default")
        .await
        .unwrap();
    let (code, rejected) = f
        .request(
            "POST",
            &f.path("/computer/connect"),
            Some(json!({"mode":"local"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 409);
    assert_eq!(rejected["code"], "COMPUTER_CLEANUP_UNKNOWN");
    assert_eq!(provider.posts.load(Ordering::SeqCst), 0);
    let connection = private_config::read(&store.directory).unwrap().unwrap();
    assert_eq!(connection.selection, "remote");
    assert!(connection.remote.is_some());
    f.state.close().await;
    task.abort();
}
