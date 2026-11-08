mod computer_support;
mod workspace_support;

use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use computer_support::{Server, connect, prepared};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::atomic::Ordering};
use tower::ServiceExt;
use workspace_support::Fixture;

const PRIVATE: &str = "COMPUTER_PRIVATE_TAKEOVER";

async fn request(
    f: &Fixture,
    method: &str,
    path: &str,
    actor: (&str, &str),
    proof: Option<&str>,
    body: Option<Value>,
) -> (u16, HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header("cookie", format!("openbot_account={}", actor.0))
        .header("x-openbot-expected-user", actor.1)
        .header("content-type", "application/json");
    if let Some(proof) = proof {
        request = request.header("x-openbot-computer-lease", proof);
    }
    let mut request = request
        .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:42001".parse::<SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let code = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (code, headers, bytes.to_vec())
}

fn json_response(response: &(u16, HeaderMap, Vec<u8>)) -> Value {
    serde_json::from_slice(&response.2).unwrap()
}

fn denied(response: &(u16, HeaderMap, Vec<u8>)) {
    assert_eq!(response.0, 409);
    assert_eq!(json_response(response)["code"], PRIVATE);
    assert!(!response.1.contains_key("x-openbot-frame-visibility"));
}

async fn second_session(f: &Fixture) -> String {
    let token = "v".repeat(43);
    sqlx::query("INSERT INTO account_sessions VALUES(?,?,?,'account','Second fixture window',1,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(hex::encode(Sha256::digest(token.as_bytes())))
        .bind(&f.owner)
        .bind(chrono::Utc::now().timestamp_millis() + 86_400_000)
        .execute(&f.db)
        .await
        .unwrap();
    token
}

#[tokio::test]
async fn private_capture_requires_same_actor_session_proof_agent_and_physical_screen() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let boot = f.bootstrap().await;
    let agent = boot["agents"][0]["id"].as_str().unwrap();
    let (created, other) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(json!({"name":"Independent fixture Bot","role":"Helper",
            "description":"","instructions":"","avatar":"orb","color":"#76568d"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(created, 201, "{other}");
    let other = other["id"].as_str().unwrap();
    let bound = prepared(&f, agent).await;
    prepared(&f, other).await;
    let screen = bound["botScreen"]["screenId"].as_str().unwrap();
    let base = f.path(&format!("/computer/bots/{agent}"));
    let public = format!("{base}/screenshot");
    let private = format!("{base}/takeover/screenshot");
    let other_public = f.path(&format!("/computer/bots/{other}/screenshot"));
    let other_private = f.path(&format!("/computer/bots/{other}/takeover/screenshot"));
    let owner = (f.owner_token.as_str(), f.owner.as_str());
    let member = (f.member_token.as_str(), f.member.as_str());
    let token = second_session(&f).await;
    let second = (token.as_str(), f.owner.as_str());

    let before = request(&f, "GET", &public, member, None, None).await;
    assert_eq!(before.0, 200);
    assert_eq!(before.1["x-openbot-frame-visibility"], "shared");

    let response = request(
        &f,
        "POST",
        &format!("{base}/takeover/start"),
        owner,
        None,
        None,
    )
    .await;
    assert_eq!(response.0, 200, "{}", String::from_utf8_lossy(&response.2));
    assert_eq!(response.1["cache-control"], "private, no-store");
    let lease = json_response(&response);
    let proof = lease["leaseId"].as_str().unwrap();
    let observed = request(
        &f,
        "GET",
        &format!("{base}/takeover/status"),
        member,
        None,
        None,
    )
    .await;
    assert_eq!(json_response(&observed)["active"], true);
    assert!(!String::from_utf8_lossy(&observed.2).contains(proof));
    assert!(!String::from_utf8_lossy(&observed.2).contains("leaseId"));

    for actor in [owner, member, second] {
        denied(&request(&f, "GET", &public, actor, None, None).await);
        denied(&request(&f, "POST", &private, actor, None, None).await);
    }
    for actor in [member, second] {
        denied(&request(&f, "POST", &private, actor, Some(proof), None).await);
    }
    denied(&request(&f, "POST", &private, owner, Some("not-a-lease"), None).await);
    denied(&request(&f, "POST", &other_private, owner, Some(proof), None).await);
    denied(
        &request(
            &f,
            "POST",
            &f.path("/computer/takeover/screenshot"),
            owner,
            Some(proof),
            None,
        )
        .await,
    );
    assert_eq!(
        request(&f, "GET", &other_public, member, None, None)
            .await
            .0,
        200
    );

    let frame = request(&f, "POST", &private, owner, Some(proof), Some(json!({}))).await;
    assert_eq!(frame.0, 200, "{}", String::from_utf8_lossy(&frame.2));
    assert_eq!(frame.1["cache-control"], "private, no-store");
    assert_eq!(frame.1["x-openbot-frame-visibility"], "takeover");
    assert_eq!(frame.1["x-computer-surface"], "browser");
    assert_eq!(frame.1["x-frame-width"], "1440");
    assert_eq!(frame.2, s.worker.private_png);
    let cleanup = request(
        &f,
        "POST",
        &format!("{base}/takeover/end"),
        owner,
        None,
        Some(json!({"leaseId":proof})),
    )
    .await;
    assert_eq!(cleanup.0, 200);
    denied(&request(&f, "POST", &private, owner, Some(proof), None).await);
    assert_eq!(request(&f, "GET", &public, member, None, None).await.0, 200);

    // A takeover started independently at the current worker stays private after
    // the Rust service loses its in-memory grant.
    let orphan = uuid::Uuid::new_v4().to_string();
    s.worker.leases.lock().await.insert(
        screen.into(),
        json!({
            "active":true,"leaseId":orphan,"surface":"browser","width":24,"height":18
        }),
    );
    denied(&request(&f, "GET", &public, member, None, None).await);
    denied(&request(&f, "POST", &private, owner, Some(&orphan), None).await);
    s.worker.leases.lock().await.remove(screen);
    assert_eq!(request(&f, "GET", &public, member, None, None).await.0, 200);
    f.close().await;
}

#[tokio::test]
async fn older_worker_keeps_verified_idle_frames_and_cannot_start_private_takeover() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    s.worker
        .private_takeover_capable
        .store(false, Ordering::SeqCst);
    connect(&f, &s.worker).await;
    let boot = f.bootstrap().await;
    let agent = boot["agents"][0]["id"].as_str().unwrap();
    let bound = prepared(&f, agent).await;
    let screen = bound["botScreen"]["screenId"].as_str().unwrap();
    let base = f.path(&format!("/computer/bots/{agent}"));
    let owner = (f.owner_token.as_str(), f.owner.as_str());
    let public = format!("{base}/screenshot");
    assert_eq!(request(&f, "GET", &public, owner, None, None).await.0, 200);
    let blocked = request(
        &f,
        "POST",
        &format!("{base}/takeover/start"),
        owner,
        None,
        None,
    )
    .await;
    assert_eq!(blocked.0, 409);
    assert_eq!(
        json_response(&blocked)["code"],
        "COMPUTER_PRIVATE_TAKEOVER_UNSUPPORTED"
    );
    assert!(
        !s.worker
            .calls
            .lock()
            .await
            .iter()
            .any(|(path, _)| path.ends_with("/takeover/start"))
    );
    s.worker.leases.lock().await.insert(screen.into(), json!({
        "active":true,"leaseId":uuid::Uuid::new_v4().to_string(),"surface":"browser","width":24,"height":18
    }));
    let count = s
        .worker
        .calls
        .lock()
        .await
        .iter()
        .filter(|(path, _)| path.ends_with("/screenshot"))
        .count();
    denied(&request(&f, "GET", &public, owner, None, None).await);
    let after = s
        .worker
        .calls
        .lock()
        .await
        .iter()
        .filter(|(path, _)| path.ends_with("/screenshot"))
        .count();
    assert_eq!(count, after);
    s.worker.leases.lock().await.remove(screen);
    assert_eq!(request(&f, "GET", &public, owner, None, None).await.0, 200);
    f.close().await;
}
