mod common;
use common::{Fixture, request};
use serde_json::json;

#[tokio::test]
async fn json_error_codes_and_language_are_stable_without_leaking_credentials() {
    let f = Fixture::new().await;
    let chinese = f.request("GET", "/api/platform/users", "", None).await;
    assert_eq!(chinese.status, 401);
    assert_eq!(chinese.value["code"], "UNAUTHENTICATED");
    assert_eq!(chinese.value["error"], "请登录平台运营后台。");
    let english = request(
        &f.app,
        "GET",
        "/api/platform/users",
        "",
        None,
        &[("accept-language", "en-US,en;q=0.8,zh-CN;q=0.2")],
    )
    .await;
    assert_eq!(english.status, 401);
    assert_eq!(english.value["code"], chinese.value["code"]);
    assert_eq!(
        english.value["error"],
        "Please sign in to the platform administration portal."
    );
    assert_eq!(english.headers["content-language"], "en");
    assert_eq!(english.headers["vary"], "Accept-Language");
    let fallback = request(
        &f.app,
        "GET",
        "/api/platform/users",
        "",
        None,
        &[("accept-language", "fr,zh-CN;q=0.9,en;q=0.5")],
    )
    .await;
    assert_eq!(fallback.value["error"], chinese.value["error"]);
    let user = f.register("user@example.test", true).await;
    let wid = user.value["workspaceId"].as_str().unwrap();
    let team = f
        .request(
            "GET",
            &format!("/api/account/workspaces/{wid}/team"),
            &user.cookie(),
            None,
        )
        .await;
    let member = &team.value["members"][0];
    assert_eq!(member["userId"], user.value["user"]["id"]);
    assert!(member.get("id").is_none());
    let serialized = team.value.to_string();
    for private in [
        "password_hash",
        "token_hash",
        "storage_key",
        "platform_role",
    ] {
        assert!(!serialized.contains(private));
    }
    f.state.close().await;
}

#[tokio::test]
async fn real_http_server_uses_peer_identity_and_preserves_cookie_login() {
    let f = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let app = f.app.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stop_rx.await;
        })
        .await
        .unwrap();
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let base = format!("http://{address}");
    let response=client.post(format!("{base}/api/account/register")).json(&json!({"email":"socket@example.test","name":"Socket","password":"fixture-password-42","kind":"personal"})).send().await.unwrap();
    assert_eq!(response.status(), 201);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let registered: serde_json::Value = response.json().await.unwrap();
    let session: serde_json::Value = client
        .get(format!("{base}/api/account/session"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(session["user"], registered["user"]);
    assert_eq!(
        client
            .post(format!("{base}/api/account/logout"))
            .header("cookie", &cookie)
            .header("origin", "https://attacker.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{base}/api/platform/users"))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    stop_tx.send(()).unwrap();
    server.await.unwrap();
    f.state.close().await;
}
