#![allow(dead_code)]
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, Semaphore};
pub const TOKEN: &str = "synthetic-computer-worker-token-only";
pub struct Worker {
    pub origin: String,
    pub workspace: String,
    pub instance: String,
    pub control_origin: Mutex<Value>,
    pub screens: Mutex<Vec<Value>>,
    pub calls: Mutex<Vec<(String, Value)>>,
    pub lifecycle: Mutex<HashMap<String, Value>>,
    pub leases: Mutex<HashMap<String, Value>>,
    pub files: Mutex<HashMap<String, Vec<u8>>>,
    pub lifecycle_count: AtomicUsize,
    pub lose_lifecycle: AtomicBool,
    pub cleanup_ok: AtomicBool,
    pub cleanup_capable: AtomicBool,
    pub private_takeover_capable: AtomicBool,
    pub browser_tabs_capable: AtomicBool,
    pub execute_gate: Mutex<Option<Arc<Semaphore>>>,
    pub cleanup_gate: Mutex<Option<Arc<Semaphore>>>,
    pub png: Vec<u8>,
    pub private_png: Vec<u8>,
}
pub struct Server {
    pub worker: Arc<Worker>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    pub async fn start(workspace: &str) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let png = |width, height| {
            let mut buffer = std::io::Cursor::new(vec![]);
            image::DynamicImage::new_rgb8(width, height)
                .write_to(&mut buffer, image::ImageFormat::Png)
                .unwrap();
            buffer.into_inner()
        };
        let worker=Arc::new(Worker{origin:format!("http://{}",listener.local_addr().unwrap()),workspace:workspace.into(),instance:uuid::Uuid::new_v4().to_string(),control_origin:Mutex::new(Value::Null),screens:Mutex::new((0..2).map(|_|json!({"id":uuid::Uuid::new_v4().to_string(),"revision":uuid::Uuid::new_v4().to_string(),"session":{"id":uuid::Uuid::new_v4().to_string(),"generation":uuid::Uuid::new_v4().to_string()},"available":true,"lifecycle":{"state":"ready"},"surface":"browser"})).collect()),calls:Mutex::new(vec![]),lifecycle:Mutex::new(HashMap::new()),leases:Mutex::new(HashMap::new()),files:Mutex::new(HashMap::from([("report.txt".into(),b"remote report".to_vec())])),lifecycle_count:AtomicUsize::new(0),lose_lifecycle:AtomicBool::new(false),cleanup_ok:AtomicBool::new(true),cleanup_capable:AtomicBool::new(true),private_takeover_capable:AtomicBool::new(true),browser_tabs_capable:AtomicBool::new(false),execute_gate:Mutex::new(None),cleanup_gate:Mutex::new(None),png:png(24,18),private_png:png(1440,900)});
        let app = Router::new().fallback(dispatch).with_state(worker.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { worker, task }
    }
}
fn response(status: u16, value: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(value)).into_response()
}
async fn dispatch(State(worker): State<Arc<Worker>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let method = request.method().clone();
    let headers = request.headers().clone();
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(&format!("Bearer {TOKEN}"))
    {
        return response(401, json!({"error":"token"}));
    }
    let bytes = to_bytes(request.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    worker.calls.lock().await.push((path.clone(), body.clone()));
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let screen = if parts.first() == Some(&"screens") && parts.len() > 1 {
        worker
            .screens
            .lock()
            .await
            .iter()
            .find(|s| s["id"] == parts[1])
            .cloned()
    } else {
        None
    };
    let suffix = if screen.is_some() {
        format!("/{}", parts[2..].join("/"))
    } else {
        path.clone()
    };
    let screen_key = screen
        .as_ref()
        .and_then(|s| s["id"].as_str())
        .unwrap_or("default")
        .to_owned();
    if suffix == "/health" {
        let mut state = json!({"protocol":"openbot-computer-v2","instanceId":worker.instance,"workspaceScopeId":worker.workspace,"controlOrigin":null,"name":"Fixture computer","platform":"linux","surface":"browser","status":"ready","connected":true,"capabilities":["operation-cleanup-v1","screen-pool-v1","screen-lifecycle-v1","action-frames","binary-file-transfer","isolated-shell-v1"]});
        state["controlOrigin"] = worker.control_origin.lock().await.clone();
        if !worker.cleanup_capable.load(Ordering::SeqCst) {
            state["capabilities"]
                .as_array_mut()
                .unwrap()
                .retain(|c| c != "operation-cleanup-v1");
        }
        if worker.browser_tabs_capable.load(Ordering::SeqCst) {
            state["capabilities"]
                .as_array_mut()
                .unwrap()
                .push(json!("browser-tabs-v1"));
        }
        if worker.private_takeover_capable.load(Ordering::SeqCst) {
            state["capabilities"]
                .as_array_mut()
                .unwrap()
                .push(json!("private-takeover-frames-v1"));
        }
        if let Some(screen) = &screen {
            state["screenId"] = screen["id"].clone();
            state["screenRevision"] = screen["revision"].clone();
            state["surface"] = screen["surface"].clone();
            state["desktop"] = json!({"kind":"virtual","session":screen["session"],"available":true,"authorized":true,"enabled":screen["surface"]=="desktop","width":1440,"height":900,"permissions":{"screenRecording":"granted","accessibility":"granted"}});
            state["capabilities"]
                .as_array_mut()
                .unwrap()
                .push(json!("virtual-desktop-v1"));
        }
        return response(200, state);
    }
    if headers
        .get("x-openbot-worker-instance")
        .and_then(|v| v.to_str().ok())
        != Some(&worker.instance)
    {
        return response(409, json!({"code":"WORKER_CONNECTION_INVALID"}));
    }
    if suffix == "/lifecycle" {
        let id = body["operationId"].as_str().unwrap_or("");
        if let Some(receipt) = worker.lifecycle.lock().await.get(id).cloned() {
            return response(200, receipt);
        }
        let Some(screen) = screen else {
            return response(404, json!({}));
        };
        if body["expectedRevision"] != screen["revision"]
            || body["expectedSession"] != screen["session"]
        {
            return response(409, json!({"error":"stale"}));
        }
        let next = json!({"revision":uuid::Uuid::new_v4().to_string(),"session":{"id":if body["kind"]=="reset"{screen["session"]["id"].as_str().unwrap().to_owned()}else{uuid::Uuid::new_v4().to_string()},"generation":uuid::Uuid::new_v4().to_string()}});
        let receipt = json!({"version":1,"operationId":id,"screenId":screen["id"],"kind":body["kind"],"status":"complete","phase":"complete","previous":{"revision":screen["revision"],"session":screen["session"]},"next":next});
        let mut screens = worker.screens.lock().await;
        let s = screens
            .iter_mut()
            .find(|s| s["id"] == screen["id"])
            .unwrap();
        s["revision"] = next["revision"].clone();
        s["session"] = next["session"].clone();
        worker
            .lifecycle
            .lock()
            .await
            .insert(id.into(), receipt.clone());
        worker.lifecycle_count.fetch_add(1, Ordering::SeqCst);
        if worker.lose_lifecycle.swap(false, Ordering::SeqCst) {
            return response(503, json!({"error":"fixture lost result"}));
        }
        return response(200, receipt);
    }
    if let Some(screen) = &screen {
        if headers
            .get("x-openbot-screen-id")
            .and_then(|v| v.to_str().ok())
            != screen["id"].as_str()
            || headers
                .get("x-openbot-screen-revision")
                .and_then(|v| v.to_str().ok())
                != screen["revision"].as_str()
        {
            return response(409, json!({"code":"WORKER_CONNECTION_INVALID"}));
        }
    }
    let gate = match suffix.as_str() {
        "/execute" | "/execute-with-frame" => worker.execute_gate.lock().await.clone(),
        "/operations/cancel" => worker.cleanup_gate.lock().await.clone(),
        _ => None,
    };
    if let Some(gate) = gate {
        gate.acquire().await.unwrap().forget();
    }
    match suffix.as_str() {
        "/screens"=>response(200,json!({"protocol":"openbot-screen-pool-v1","instanceId":worker.instance,"workspaceScopeId":worker.workspace,"capacity":{"max":2,"configured":2,"ready":2},"screens":worker.screens.lock().await.clone()})),
        "/operations/cancel"=>response(200,json!({"id":body["id"],"stopped":worker.cleanup_ok.load(Ordering::SeqCst),"cleanupConfirmed":worker.cleanup_ok.load(Ordering::SeqCst)})),
        "/shell/cancel"=>response(200,json!({"stopped":true})),
        "/takeover/status"=>response(200,worker.leases.lock().await.get(&screen_key).cloned().unwrap_or_else(||json!({"active":false,"width":1440,"height":900,"surface":screen.as_ref().map(|s|s["surface"].clone()).unwrap_or(json!("browser"))}))),
        "/takeover/start"=>{let lease=json!({"active":true,"leaseId":uuid::Uuid::new_v4().to_string(),"expiresAt":(chrono::Utc::now()+chrono::Duration::minutes(5)).to_rfc3339(),"width":1440,"height":900,"surface":screen.as_ref().map(|s|s["surface"].clone()).unwrap_or(json!("browser"))});worker.leases.lock().await.insert(screen_key,lease.clone());response(200,lease)},
        "/takeover/end"=>{worker.leases.lock().await.remove(&screen_key);response(200,json!({"active":false}))},
        "/takeover/input"=>response(200,json!({"ok":true})),
        "/surface"=>{if let Some(screen)=screen{worker.screens.lock().await.iter_mut().find(|s|s["id"]==screen["id"]).unwrap()["surface"]=body["surface"].clone();}response(200,json!({"ok":true}))},
        "/screenshot" => {
            let supplied = headers.get("x-openbot-computer-lease").and_then(|value| value.to_str().ok());
            if worker.private_takeover_capable.load(Ordering::SeqCst) {
                let leases = worker.leases.lock().await;
                let active = leases.get(&screen_key).and_then(|lease| lease["leaseId"].as_str());
                if active != supplied {
                    return response(409, json!({"code":"COMPUTER_PRIVATE_TAKEOVER"}));
                }
            }
            let surface = screen.as_ref().and_then(|value| value["surface"].as_str()).unwrap_or("browser");
            let png = if supplied.is_some() { &worker.private_png } else { &worker.png };
            ([("content-type","image/png"),("x-computer-surface",surface)], png.clone()).into_response()
        },
        "/execute-with-frame"=>response(200,json!({"result":{"ok":true},"frame":{"mimeType":"image/png","data":STANDARD.encode(&worker.png),"capturedAt":chrono::Utc::now().to_rfc3339()}})),
        "/execute"=>response(200,json!({"ok":true,"stdout":"fixture","stderr":"","exitCode":0,"truncated":false,"timedOut":false,"cancelled":false,"durationMs":1})),
        "/files/content"=>{
            let path=url::form_urlencoded::parse(query.as_bytes()).find(|(k,_)|k=="path").map(|(_,v)|v.into_owned()).unwrap_or_default();
            if method==axum::http::Method::PUT {worker.files.lock().await.insert(path.clone(),bytes.to_vec());response(201,json!({"path":path,"size":bytes.len()}))}
            else{match worker.files.lock().await.get(&path){Some(bytes)=>([("content-type","application/octet-stream")],bytes.clone()).into_response(),None=>response(404,json!({}))}}
        },
        "/files"=>response(200,json!({"path":".","entries":[{"name":"report.txt","path":"report.txt","kind":"file","size":13}],"truncated":false})),
        _=>response(404,json!({"error":"fixture route"})),
    }
}
pub async fn connect(f: &crate::workspace_support::Fixture, worker: &Worker) -> Value {
    let (status, body) = f
        .request(
            "POST",
            &f.path("/computer/connect"),
            Some(json!({"mode":"remote","url":worker.origin,"token":TOKEN})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body
}
pub async fn prepared(f: &crate::workspace_support::Fixture, agent: &str) -> Value {
    let (status, body) = f
        .request(
            "POST",
            &f.path(&format!("/computer/bots/{agent}/prepare")),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["botScreen"]["status"], "ready", "{body}");
    body
}
pub async fn settled(f: &crate::workspace_support::Fixture, id: &str) -> Value {
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    for _ in 0..100 {
        let action = openbot_backend::computer::action_store::get(&store, id)
            .await
            .unwrap();
        if !matches!(action["status"].as_str(), Some("pending" | "running")) {
            return action;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("computer action did not finish")
}

pub async fn seeded(f: &crate::workspace_support::Fixture) -> Value {
    let (status,body)=f.request("POST",&f.path("/agents"),Some(json!({"name":"Second fixture Bot","role":"Review","description":"Fixture","instructions":"","avatar":"leaf","color":"#445566"})),false,Some(&f.owner)).await;
    assert_eq!(status, 201, "{body}");
    f.bootstrap().await
}
