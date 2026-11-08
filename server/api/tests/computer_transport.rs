use axum::{
    Json, Router,
    extract::{Request, State},
    response::IntoResponse,
    routing::any,
};
use openbot_backend::computer::{
    model::{self, DesktopSession, ScreenBinding},
    private_config::{self, SavedConnection},
    transport::{Authority, Request as WorkerRequest, Target},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{Mutex, Semaphore};

const TOKEN: &str = "synthetic-worker-token-for-fixture-only";
const WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
const SCREEN: &str = "22222222-2222-4222-8222-222222222222";
const SESSION: &str = "33333333-3333-4333-8333-333333333333";
const GENERATION: &str = "44444444-4444-4444-8444-444444444444";
const REVISION: &str = "55555555-5555-4555-8555-555555555555";
const INSTANCE: &str = "66666666-6666-4666-8666-666666666666";
#[derive(Clone)]
struct Worker {
    health: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<(String, axum::http::HeaderMap, Value)>>>,
    started: Arc<Semaphore>,
    cancel_started: Arc<Semaphore>,
    complete: Arc<Semaphore>,
    cleanup: Arc<Semaphore>,
    delayed: Arc<AtomicBool>,
    cleanup_ok: Arc<AtomicBool>,
    input_count: Arc<AtomicUsize>,
}
impl Worker {
    fn new() -> Self {
        Self {
            health: Arc::new(Mutex::new(
                json!({"protocol":model::PROTOCOL,"instanceId":INSTANCE,
            "workspaceScopeId":WORKSPACE,"name":"Fixture computer","platform":"linux","connected":true,
            "surface":"browser","status":"ready","controlOrigin":null,
            "capabilities":[model::CLEANUP,model::SCREEN_POOL,model::PRIVATE_TAKEOVER,"virtual-desktop-v1"],
            "desktop":{"kind":"virtual","session":{"id":SESSION,"generation":GENERATION},"available":true,"authorized":true,
                "enabled":false,"width":1440,"height":900,"permissions":{"screenRecording":"granted","accessibility":"granted"}}}),
            )),
            requests: Arc::new(Mutex::new(vec![])),
            started: Arc::new(Semaphore::new(0)),
            cancel_started: Arc::new(Semaphore::new(0)),
            complete: Arc::new(Semaphore::new(0)),
            cleanup: Arc::new(Semaphore::new(0)),
            delayed: Arc::new(AtomicBool::new(false)),
            cleanup_ok: Arc::new(AtomicBool::new(true)),
            input_count: Arc::new(AtomicUsize::new(0)),
        }
    }
}
struct Fixture {
    worker: Worker,
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn fixture() -> Fixture {
    let worker = Worker::new();
    let app = Router::new()
        .fallback(any(dispatch))
        .with_state(worker.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Fixture { worker, url, task }
}
async fn dispatch(State(worker): State<Worker>, request: Request) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let headers = request.headers().clone();
    assert_eq!(
        headers.get("authorization").unwrap(),
        format!("Bearer {TOKEN}").as_str()
    );
    let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    worker
        .requests
        .lock()
        .await
        .push((path.clone(), headers.clone(), body.clone()));
    if path.ends_with("/health") {
        let mut health = worker.health.lock().await.clone();
        if path.starts_with("/screens/") {
            health["screenId"] = json!(SCREEN);
            health["screenRevision"] = json!(REVISION);
        }
        return Json(health).into_response();
    }
    assert_eq!(headers.get("x-openbot-worker-instance").unwrap(), INSTANCE);
    assert_eq!(headers.get("x-openbot-control-origin").unwrap(), "none");
    if path.ends_with("/operations/cancel") {
        worker.cancel_started.add_permits(1);
        if worker.delayed.load(Ordering::SeqCst) {
            worker.cleanup.acquire().await.unwrap().forget();
        }
        return Json(json!({"id":body["id"],"stopped":worker.cleanup_ok.load(Ordering::SeqCst),"cleanupConfirmed":worker.cleanup_ok.load(Ordering::SeqCst)})).into_response();
    }
    if path.ends_with("/takeover/start") {
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"error":"lost lease receipt"})),
        )
            .into_response();
    }
    if path.ends_with("/execute") {
        worker.input_count.fetch_add(1, Ordering::SeqCst);
        worker.started.add_permits(1);
        if worker.delayed.load(Ordering::SeqCst) {
            worker.complete.acquire().await.unwrap().forget();
        }
        return Json(json!({"ok":true,"received":body})).into_response();
    }
    Json(json!({"ok":true})).into_response()
}
fn authority(flag: Arc<AtomicBool>) -> Authority {
    Arc::new(move || {
        let flag = flag.clone();
        Box::pin(async move {
            if flag.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(openbot_backend::error::ApiError::new(
                    403,
                    "fixture revoked",
                ))
            }
        })
    })
}
fn allow() -> Authority {
    authority(Arc::new(AtomicBool::new(true)))
}
async fn target(fixture: &Fixture, binding: Option<ScreenBinding>) -> Arc<Target> {
    Target::discover(&fixture.url, TOKEN, WORKSPACE, None, binding, None, allow())
        .await
        .unwrap()
}
async fn wait(sem: &Semaphore) {
    tokio::time::timeout(std::time::Duration::from_secs(3), sem.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}

#[tokio::test]
async fn pins_worker_screen_session_and_confirms_cleanup_after_success() {
    let fixture = fixture().await;
    let binding = ScreenBinding {
        agent_id: "fixture_bot".into(),
        screen_id: SCREEN.into(),
        assignment_revision: uuid::Uuid::new_v4().to_string(),
        screen_revision: Some(REVISION.into()),
        session: DesktopSession {
            id: SESSION.into(),
            generation: GENERATION.into(),
        },
    };
    let target = target(&fixture, Some(binding)).await;
    let result = target
        .request(
            WorkerRequest::post(
                "/execute",
                &json!({"type":"browser_click","selector":"#save"}),
            ),
            allow(),
        )
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(result["ok"], true);
    let requests = fixture.worker.requests.lock().await;
    let execute = requests
        .iter()
        .find(|(p, _, _)| p.ends_with("/execute"))
        .unwrap();
    assert_eq!(execute.0, format!("/screens/{SCREEN}/execute"));
    for (header, value) in [
        ("x-openbot-screen-id", SCREEN),
        ("x-openbot-screen-revision", REVISION),
        ("x-openbot-workspace-scope", WORKSPACE),
        ("x-openbot-desktop-session", SESSION),
        ("x-openbot-desktop-generation", GENERATION),
    ] {
        assert_eq!(execute.1.get(header).unwrap(), value);
    }
    let cancel = requests
        .iter()
        .find(|(p, _, _)| p.ends_with("/operations/cancel"))
        .unwrap();
    assert_eq!(
        cancel.2["id"],
        execute
            .1
            .get("x-openbot-operation-id")
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert!(!target.state().await.to_string().contains(TOKEN));
}

#[tokio::test]
async fn changed_incarnation_cannot_receive_a_prepared_operation() {
    let fixture = fixture().await;
    let target = target(&fixture, None).await;
    fixture.worker.health.lock().await["instanceId"] = json!(uuid::Uuid::new_v4().to_string());
    let error = target
        .request(
            WorkerRequest::post("/execute", &json!({"type":"browser_back"})),
            allow(),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "WORKER_CONNECTION_INVALID");
    assert!(target.is_blocked());
    assert_eq!(fixture.worker.input_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn dropped_http_consumer_keeps_queue_until_remote_cleanup_is_proven() {
    let fixture = fixture().await;
    fixture.worker.delayed.store(true, Ordering::SeqCst);
    let target = target(&fixture, None).await;
    let first = {
        let t = target.clone();
        tokio::spawn(async move {
            t.request(
                WorkerRequest::post("/execute", &json!({"type":"browser_back"})),
                allow(),
            )
            .await
        })
    };
    wait(&fixture.worker.started).await;
    first.abort();
    let _ = first.await;
    wait(&fixture.worker.cancel_started).await;
    assert_eq!(target.active_count(), 1);
    let second = {
        let t = target.clone();
        tokio::spawn(async move {
            t.request(
                WorkerRequest::post("/execute", &json!({"type":"browser_back"})),
                allow(),
            )
            .await
        })
    };
    tokio::task::yield_now().await;
    assert_eq!(fixture.worker.input_count.load(Ordering::SeqCst), 1);
    fixture.worker.delayed.store(false, Ordering::SeqCst);
    fixture.worker.cleanup.add_permits(1);
    assert!(second.await.unwrap().is_ok());
    assert_eq!(fixture.worker.input_count.load(Ordering::SeqCst), 2);
    assert!(!target.is_blocked());
    fixture.worker.complete.add_permits(1);
}

#[tokio::test]
async fn authority_revocation_cancels_and_unknown_cleanup_blocks_future_work() {
    let fixture = fixture().await;
    fixture.worker.delayed.store(true, Ordering::SeqCst);
    fixture.worker.cleanup_ok.store(false, Ordering::SeqCst);
    let target = target(&fixture, None).await;
    let permitted = Arc::new(AtomicBool::new(true));
    let job = {
        let t = target.clone();
        let a = authority(permitted.clone());
        tokio::spawn(async move {
            t.request(
                WorkerRequest::post(
                    "/execute",
                    &json!({"type":"desktop_drag","x":1,"y":2,"toX":3,"toY":4}),
                ),
                a,
            )
            .await
        })
    };
    wait(&fixture.worker.started).await;
    permitted.store(false, Ordering::SeqCst);
    wait(&fixture.worker.cancel_started).await;
    assert!(!job.is_finished());
    fixture.worker.cleanup.add_permits(1);
    assert_eq!(
        job.await.unwrap().err().unwrap().code,
        "COMPUTER_CLEANUP_UNKNOWN"
    );
    assert!(
        target
            .request(WorkerRequest::get("/health"), allow())
            .await
            .is_err()
    );
    assert_eq!(fixture.worker.input_count.load(Ordering::SeqCst), 1);
    fixture.worker.complete.add_permits(1);
}

#[tokio::test]
async fn private_connection_round_trip_preserves_pin_and_never_accepts_redirect_credentials() {
    let fixture = fixture().await;
    let target = target(&fixture, None).await;
    let directory = tempfile::tempdir().unwrap();
    let saved = SavedConnection {
        version: 1,
        selection: "remote".into(),
        remote: Some(target.saved.clone()),
    };
    private_config::write(directory.path(), &saved).unwrap();
    let restored = private_config::read(directory.path()).unwrap().unwrap();
    assert_eq!(restored.remote.unwrap().instance_id, INSTANCE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.path().join("computer/connection.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    for value in [
        "http://worker.example.test",
        "https://user:pass@worker.example.test",
        "https://worker.example.test/?token=x",
    ] {
        assert!(model::worker_url(value).is_err());
    }
    assert!(
        Target::discover(
            &fixture.url,
            TOKEN,
            "77777777-7777-4777-8777-777777777777",
            None,
            None,
            None,
            allow()
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn lost_takeover_start_response_disables_connection_instead_of_allowing_new_input() {
    let fixture = fixture().await;
    let target = target(&fixture, None).await;
    assert!(
        target
            .request(WorkerRequest::post("/takeover/start", &json!({})), allow())
            .await
            .is_err()
    );
    assert!(target.is_blocked());
    assert!(
        target
            .request(
                WorkerRequest::post(
                    "/execute",
                    &json!({"type":"terminal_command","command":"pwd"})
                ),
                allow()
            )
            .await
            .is_err()
    );
    assert_eq!(fixture.worker.input_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cleanup_reaches_original_worker_when_cloud_probe_becomes_unavailable() {
    let fixture = fixture().await;
    fixture.worker.delayed.store(true, Ordering::SeqCst);
    let target = target(&fixture, None).await;
    let provider_ok = Arc::new(AtomicBool::new(true));
    target.set_probe(Some(authority(provider_ok.clone()))).await;
    let actor_ok = Arc::new(AtomicBool::new(true));
    let request = {
        let target = target.clone();
        let actor = actor_ok.clone();
        tokio::spawn(async move {
            target
                .request(
                    WorkerRequest::post(
                        "/execute",
                        &json!({"type":"write_file","path":"fixture.txt","content":"fixture"}),
                    ),
                    authority(actor),
                )
                .await
        })
    };
    wait(&fixture.worker.started).await;
    provider_ok.store(false, Ordering::SeqCst);
    actor_ok.store(false, Ordering::SeqCst);
    wait(&fixture.worker.cancel_started).await;
    assert!(!request.is_finished());
    fixture.worker.cleanup.add_permits(1);
    assert!(request.await.unwrap().is_err());
    assert!(!target.is_blocked());
    let calls = fixture.worker.requests.lock().await;
    let cancel = calls
        .iter()
        .find(|(path, _, _)| path == "/operations/cancel")
        .unwrap();
    assert_eq!(cancel.1["x-openbot-worker-instance"], INSTANCE);
    assert_eq!(cancel.1["authorization"], format!("Bearer {TOKEN}"));
}
