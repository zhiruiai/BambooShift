mod apps_support;
#[path = "apps_oauth/disconnected.rs"]
mod disconnected;
mod workspace_support;
use apps_support::*;
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use openbot_backend::apps;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, atomic::Ordering};
use tower::ServiceExt;
use workspace_support::Fixture;

async fn raw(
    f: &Fixture,
    method: &str,
    path: &str,
    body: Option<Value>,
    cookie: &str,
    user: Option<&str>,
    cross_site: bool,
) -> (u16, HeaderMap, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3002")
        .header("cookie", cookie)
        .header("content-type", "application/json");
    if let Some(user) = user {
        request = request.header("x-openbot-expected-user", user);
    }
    if cross_site {
        request = request.header("sec-fetch-site", "cross-site");
    } else {
        request = request.header("origin", "http://127.0.0.1:3002");
    }
    let mut request = request
        .body(
            body.map(|v| Body::from(v.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41321".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(json!({})),
    )
}
async fn fixture() -> (Fixture, Server, Value) {
    let server = Server::start().await;
    server.remote.oauth.store(true, Ordering::SeqCst);
    let mut f = Fixture::new().await;
    f.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    let(status,c)=f.request("POST",&f.path("/apps"),Some(json!({"name":"OAuth notes","url":format!("{}/mcp",server.remote.origin),"authType":"oauth","shared":true})),false,Some(&f.owner)).await;
    assert_eq!(status, 200, "{c}");
    assert_eq!(c["status"], "needs_auth");
    (f, server, c)
}
async fn start(f: &Fixture, c: &Value) -> Value {
    let (status, flow) = f
        .request(
            "POST",
            &f.path(&format!("/apps/{}/oauth/start", c["id"].as_str().unwrap())),
            Some(json!({"expectedRevision":c["revision"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{flow}");
    assert_eq!(flow["status"], "pending", "{flow}");
    assert!(flow["issuer"].is_string());
    assert_eq!(flow["scopes"], json!(["notes.read", "notes.write"]));
    assert!(!flow.to_string().contains("code_verifier"));
    flow
}
fn flowpath(f: &Fixture, c: &Value, flow: &Value) -> String {
    f.path(&format!(
        "/apps/{}/oauth/{}",
        c["id"].as_str().unwrap(),
        flow["id"].as_str().unwrap()
    ))
}
async fn callback_url(authorization: &str) -> String {
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(authorization)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 302);
    let url = url::Url::parse(
        response
            .headers()
            .get("location")
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap();
    format!("{}?{}", url.path(), url.query().unwrap())
}
async fn add_browser_session(f: &Fixture) -> String {
    let token = "b".repeat(43);
    sqlx::query("INSERT INTO account_sessions VALUES(?,?,?,?, 'Browser',1,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(hex::encode(Sha256::digest(token.as_bytes())))
        .bind(&f.owner)
        .bind("account")
        .bind(chrono::Utc::now().timestamp_millis() + 86_400_000)
        .execute(&f.db)
        .await
        .unwrap();
    format!("openbot_account={token}")
}
#[tokio::test]
async fn real_cross_browser_pkce_requires_nonce_original_session_and_explicit_finish() {
    let (f, s, c) = fixture().await;
    let flow = start(&f, &c).await;
    let path = flowpath(&f, &c, &flow);
    let original = format!("openbot_account={}", f.owner_token);
    let browser = add_browser_session(&f).await;
    let (status, launch) = f
        .request(
            "POST",
            &(path.clone() + "/launch"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(launch["launchPath"], flow["launchPath"]);
    assert_eq!(
        f.request(
            "GET",
            &(path.clone() + "/handoff"),
            None,
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    let (status, _, handoff) = raw(
        &f,
        "GET",
        &(path.clone() + "/handoff"),
        None,
        &browser,
        Some(&f.owner),
        false,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(handoff["issuer"], s.remote.origin);
    assert!(handoff.get("authorizationUrl").is_none());
    let (status, headers, begin) = raw(
        &f,
        "POST",
        &(path.clone() + "/begin"),
        Some(json!({})),
        &browser,
        Some(&f.owner),
        false,
    )
    .await;
    assert_eq!(status, 200, "{begin}");
    let cookie = headers
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert!(
        headers["set-cookie"]
            .to_str()
            .unwrap()
            .contains("SameSite=Lax")
    );
    let callback = callback_url(begin["authorizationUrl"].as_str().unwrap()).await;
    assert_eq!(raw(&f, "GET", &callback, None, "", None, true).await.0, 400);
    let (status, headers, _) = raw(&f, "GET", &callback, None, &cookie, None, true).await;
    assert_eq!(status, 303);
    assert_eq!(headers["location"], "/api/app-oauth/result");
    assert_eq!(s.remote.tokens.lock().await.len(), 0);
    assert_eq!(
        raw(&f, "GET", &callback, None, &cookie, None, true).await.0,
        400
    );
    let (status, view) = f.request("GET", &path, None, false, Some(&f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(view["status"], "callback_received");
    assert_eq!(
        raw(
            &f,
            "POST",
            &(path.clone() + "/finish"),
            Some(json!({})),
            &browser,
            Some(&f.owner),
            false
        )
        .await
        .0,
        404
    );
    let (status, _, complete) = raw(
        &f,
        "POST",
        &(path.clone() + "/finish"),
        Some(json!({})),
        &original,
        Some(&f.owner),
        false,
    )
    .await;
    assert_eq!(status, 200, "{complete}");
    assert_eq!(complete["status"], "complete", "{complete}");
    assert_eq!(s.remote.tokens.lock().await.len(), 1);
    let apps = f.bootstrap().await["apps"].clone();
    assert_eq!(apps[0]["status"], "connected");
    assert_eq!(apps[0]["toolCount"], 1);
    assert_eq!(
        apps[0]["authorization"]["scopes"],
        json!(["notes.read", "notes.write"])
    );
    assert!(!apps.to_string().contains("synthetic-oauth-"));
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let credential_path = store.directory.join("config/apps.private.json");
    let mut private: Value =
        serde_json::from_slice(&std::fs::read(&credential_path).unwrap()).unwrap();
    for entry in private["entries"].as_object_mut().unwrap().values_mut() {
        if entry["owner"] == c["id"] {
            entry["payload"]["grant"]["expiresAt"] = json!(0);
        }
    }
    std::fs::write(&credential_path, private.to_string()).unwrap();
    s.remote.narrow_scopes.store(true, Ordering::SeqCst);
    let (status, refreshed) = f
        .request(
            "POST",
            &f.path(&format!("/apps/{}/reconnect", c["id"].as_str().unwrap())),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{refreshed}");
    assert_eq!(refreshed["status"], "connected");
    assert_eq!(s.remote.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(refreshed["authorization"]["scopes"], json!(["notes.read"]));
    let (status, disconnected) = f
        .request(
            "POST",
            &f.path(&format!("/apps/{}/disconnect", c["id"].as_str().unwrap())),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(disconnected["hasCredential"], false);
    wait_until(|| s.remote.revoked.load(Ordering::SeqCst) == 1).await;
    f.close().await;
}
#[tokio::test]
async fn cancelled_flow_rejects_delayed_callback_without_token_exchange() {
    let (f, s, c) = fixture().await;
    let flow = start(&f, &c).await;
    let path = flowpath(&f, &c, &flow);
    let cookie = format!("openbot_account={}", f.owner_token);
    let (status, headers, begin) = raw(
        &f,
        "POST",
        &(path.clone() + "/begin"),
        Some(json!({})),
        &cookie,
        Some(&f.owner),
        false,
    )
    .await;
    assert_eq!(status, 200);
    let nonce = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let callback = callback_url(begin["authorizationUrl"].as_str().unwrap()).await;
    assert_eq!(
        f.request(
            "POST",
            &(path.clone() + "/cancel"),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .1["status"],
        "cancelled"
    );
    assert_eq!(
        raw(&f, "GET", &callback, None, nonce, None, true).await.0,
        400
    );
    assert_eq!(s.remote.tokens.lock().await.len(), 0);
    f.close().await;
}
#[tokio::test]
async fn begin_is_single_use_and_revoked_original_session_invalidates_handoff() {
    let (f, s, c) = fixture().await;
    let flow = start(&f, &c).await;
    let path = flowpath(&f, &c, &flow);
    let browser = add_browser_session(&f).await;
    assert_eq!(
        raw(
            &f,
            "POST",
            &(path.clone() + "/begin"),
            Some(json!({})),
            &browser,
            Some(&f.owner),
            false
        )
        .await
        .0,
        200
    );
    assert_eq!(
        raw(
            &f,
            "POST",
            &(path.clone() + "/begin"),
            Some(json!({})),
            &browser,
            Some(&f.owner),
            false
        )
        .await
        .0,
        409
    );
    sqlx::query("DELETE FROM account_sessions WHERE token_hash=?")
        .bind(hex::encode(Sha256::digest(f.owner_token.as_bytes())))
        .execute(&f.db)
        .await
        .unwrap();
    let (status, _, view) = raw(
        &f,
        "GET",
        &(path.clone() + "/handoff"),
        None,
        &browser,
        Some(&f.owner),
        false,
    )
    .await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["status"], "cancelled");
    assert_eq!(s.remote.tokens.lock().await.len(), 0);
    f.close().await;
}
#[tokio::test]
async fn cross_site_exception_only_allows_exact_oauth_navigation_gets() {
    let f = Fixture::new().await;
    let cookie = format!("openbot_account={}", f.owner_token);
    assert_eq!(
        raw(
            &f,
            "GET",
            &f.path("/apps"),
            None,
            &cookie,
            Some(&f.owner),
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        raw(
            &f,
            "POST",
            "/api/app-oauth/callback",
            Some(json!({})),
            &cookie,
            None,
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        raw(&f, "GET", "/api/app-oauth/result", None, "", None, true)
            .await
            .0,
        200
    );
    f.close().await;
}
