mod workspace_support;
use axum::{body::Body, extract::ConnectInfo, http::Request};
use http_body_util::BodyExt;
use serde_json::json;
use std::{net::SocketAddr, time::Duration};
use tower::ServiceExt;
use workspace_support::Fixture;

async fn connect(f: &Fixture) -> Body {
    let mut request = Request::builder()
        .uri(f.path("/events"))
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header("cookie", format!("openbot_account={}", f.owner_token))
        .header("x-openbot-expected-user", &f.owner)
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41322".parse::<SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.into_body()
}
async fn frame(body: &mut Body) -> Option<String> {
    tokio::time::timeout(Duration::from_secs(3), body.frame())
        .await
        .expect("SSE must settle")
        .map(|f| String::from_utf8(f.unwrap().into_data().unwrap().to_vec()).unwrap())
}
#[tokio::test]
async fn sse_announces_committed_events_and_closes_when_original_account_session_expires() {
    let f = Fixture::new().await;
    let _ = f.bootstrap().await;
    let mut body = connect(&f).await;
    assert!(frame(&mut body).await.unwrap().contains("event: sync"));
    assert!(frame(&mut body).await.unwrap().contains("event: connected"));
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    store.emit("update", json!({}));
    let event = frame(&mut body).await.unwrap();
    assert!(event.contains("event: update"));
    assert!(event.contains("data: {}"));
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    assert!(frame(&mut body).await.is_none());
    f.close().await;
}
#[tokio::test]
async fn workspace_shutdown_ends_sse_without_waiting_for_client_disconnect() {
    let f = Fixture::new().await;
    let _ = f.bootstrap().await;
    let mut body = connect(&f).await;
    let _ = frame(&mut body).await;
    let _ = frame(&mut body).await;
    f.state.workspace.close().await;
    assert!(frame(&mut body).await.is_none());
    f.close().await;
}
