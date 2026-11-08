#![allow(dead_code)]
use axum::{
    Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Mutex;

pub struct Remote {
    pub origin: String,
    pub calls: AtomicUsize,
    pub refreshes: AtomicUsize,
    pub revoked: AtomicUsize,
    pub metadata_changed: AtomicBool,
    pub hold: AtomicBool,
    pub hold_refresh: AtomicBool,
    pub hold_registration: AtomicBool,
    pub hold_exchange: AtomicBool,
    pub exchanges: AtomicUsize,
    pub bearer: AtomicBool,
    pub oauth: AtomicBool,
    pub narrow_scopes: AtomicBool,
    pub tokens: Mutex<Vec<String>>,
    pub codes: Mutex<HashMap<String, Value>>,
    pub registrations: Mutex<HashMap<String, Value>>,
    pub catalog: Mutex<Option<Vec<Value>>>,
}
pub struct Server {
    pub remote: Arc<Remote>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    pub async fn start() -> Self {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote = Arc::new(Remote {
            origin: format!("http://{}", socket.local_addr().unwrap()),
            calls: AtomicUsize::new(0),
            refreshes: AtomicUsize::new(0),
            revoked: AtomicUsize::new(0),
            metadata_changed: AtomicBool::new(false),
            hold: AtomicBool::new(false),
            hold_refresh: AtomicBool::new(false),
            hold_registration: AtomicBool::new(false),
            hold_exchange: AtomicBool::new(false),
            exchanges: AtomicUsize::new(0),
            bearer: AtomicBool::new(false),
            oauth: AtomicBool::new(false),
            narrow_scopes: AtomicBool::new(false),
            tokens: Mutex::new(vec![]),
            codes: Mutex::new(HashMap::new()),
            registrations: Mutex::new(HashMap::new()),
            catalog: Mutex::new(None),
        });
        let app = Router::new().fallback(endpoint).with_state(remote.clone());
        let task = tokio::spawn(async move {
            axum::serve(socket, app).await.unwrap();
        });
        Self { remote, task }
    }
}
fn json_response(status: u16, value: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), axum::Json(value)).into_response()
}
async fn endpoint(State(remote): State<Arc<Remote>>, request: Request) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    let bytes = to_bytes(request.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let origin = &remote.origin;
    let query: HashMap<String, String> =
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
    let form: HashMap<String, String> = url::form_urlencoded::parse(&bytes)
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match uri.path() {
        "/redirect" => (
            StatusCode::TEMPORARY_REDIRECT,
            [(header::LOCATION, format!("{origin}/mcp"))],
        )
            .into_response(),
        "/huge" => (
            [(header::CONTENT_TYPE, "application/json")],
            "x".repeat(1024 * 1024 + 1),
        )
            .into_response(),
        "/mcp" => {
            let auth = headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if (remote.bearer.load(Ordering::SeqCst) && auth != "Bearer synthetic-access")
                || (remote.oauth.load(Ordering::SeqCst)
                    && !remote
                        .tokens
                        .lock()
                        .await
                        .iter()
                        .any(|t| auth == format!("Bearer {t}")))
            {
                return (StatusCode::UNAUTHORIZED,[(header::WWW_AUTHENTICATE,format!("Bearer resource_metadata=\"{origin}/resource\", scope=\"notes.read notes.write\""))]).into_response();
            }
            if method == "DELETE" {
                return StatusCode::OK.into_response();
            }
            match body["method"].as_str().unwrap_or("") {
                "initialize" => json_response(
                    200,
                    json!({"jsonrpc":"2.0","id":body["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}),
                ),
                "notifications/initialized" => StatusCode::ACCEPTED.into_response(),
                "tools/list" => json_response(
                    200,
                    json!({"jsonrpc":"2.0","id":body["id"],"result":{"tools":remote.catalog.lock().await.clone().unwrap_or_else(||vec![json!({"name":"write_note","description":if remote.metadata_changed.load(Ordering::SeqCst){"Changed description"}else{"Write a synthetic note"},"inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}})])}}),
                ),
                "tools/call" => {
                    remote.calls.fetch_add(1, Ordering::SeqCst);
                    while remote.hold.load(Ordering::SeqCst) {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                    json_response(
                        200,
                        json!({"jsonrpc":"2.0","id":body["id"],"result":{"content":[{"type":"text","text":format!("{} {auth}",body["params"]["arguments"]["text"].as_str().unwrap_or("done"))}],"isError":false}}),
                    )
                }
                _ => json_response(400, json!({"error":"unsupported"})),
            }
        }
        "/resource" => json_response(
            200,
            json!({"resource":format!("{origin}/mcp"),"authorization_servers":[origin],"scopes_supported":["notes.read","notes.write"]}),
        ),
        "/.well-known/oauth-authorization-server" => json_response(
            200,
            json!({"issuer":origin,"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"registration_endpoint":format!("{origin}/register"),"revocation_endpoint":format!("{origin}/revoke"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"authorization_response_iss_parameter_supported":true}),
        ),
        "/register" => {
            let id = uuid::Uuid::new_v4().to_string();
            remote
                .registrations
                .lock()
                .await
                .insert(id.clone(), body.clone());
            let mut registered = body;
            registered["client_id"] = json!(id);
            while remote.hold_registration.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            json_response(201, registered)
        }
        "/authorize" => {
            if query.get("code_challenge_method").map(String::as_str) != Some("S256")
                || query.get("resource") != Some(&format!("{origin}/mcp"))
            {
                return json_response(400, json!({"error":"invalid_request"}));
            }
            let registered = remote
                .registrations
                .lock()
                .await
                .get(query.get("client_id").unwrap_or(&String::new()))
                .cloned();
            if registered.is_none_or(|v| {
                !v["redirect_uris"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(query.get("redirect_uri")))
            }) {
                return json_response(400, json!({"error":"invalid_client"}));
            }
            let code = uuid::Uuid::new_v4().to_string();
            remote.codes.lock().await.insert(code.clone(), json!(query));
            let mut location = url::Url::parse(query.get("redirect_uri").unwrap()).unwrap();
            location
                .query_pairs_mut()
                .append_pair("state", query.get("state").unwrap())
                .append_pair("code", &code)
                .append_pair("iss", origin);
            (
                StatusCode::FOUND,
                [(header::LOCATION, location.to_string())],
            )
                .into_response()
        }
        "/token" => {
            if form.get("grant_type").map(String::as_str) == Some("authorization_code") {
                remote.exchanges.fetch_add(1, Ordering::SeqCst);
                let previous = remote
                    .codes
                    .lock()
                    .await
                    .remove(form.get("code").unwrap_or(&String::new()));
                let challenge =
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(
                        form.get("code_verifier")
                            .unwrap_or(&String::new())
                            .as_bytes(),
                    ));
                if previous.is_none_or(|v| {
                    v["code_challenge"] != challenge
                        || v["client_id"] != json!(form.get("client_id"))
                        || v["redirect_uri"] != json!(form.get("redirect_uri"))
                }) {
                    return json_response(400, json!({"error":"invalid_grant"}));
                }
                while remote.hold_exchange.load(Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            } else {
                remote.refreshes.fetch_add(1, Ordering::SeqCst);
                while remote.hold_refresh.load(Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
            let token = format!("synthetic-oauth-{}", uuid::Uuid::new_v4());
            remote.tokens.lock().await.push(token.clone());
            json_response(
                200,
                json!({"access_token":token,"token_type":"Bearer","expires_in":3600,"refresh_token":"synthetic-refresh","scope":if remote.narrow_scopes.load(Ordering::SeqCst){"notes.read"}else{"notes.read notes.write"}}),
            )
        }
        "/revoke" => {
            remote.revoked.fetch_add(1, Ordering::SeqCst);
            json_response(200, json!({}))
        }
        path if path.starts_with("/.well-known/oauth-protected-resource") => json_response(
            200,
            json!({"resource":format!("{origin}/mcp"),"authorization_servers":[origin],"scopes_supported":["notes.read","notes.write"]}),
        ),
        _ => json_response(404, json!({})),
    }
}
pub fn headers(token: &str, user: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("openbot_account={token}").parse().unwrap(),
    );
    headers.insert("x-openbot-expected-user", user.parse().unwrap());
    headers
}
pub async fn wait_until(mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(check(), "fixture did not reach expected state");
}
