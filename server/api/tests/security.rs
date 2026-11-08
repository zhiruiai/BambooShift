mod common;
use axum::{body::Body, http::Request};
use common::{Fixture, request};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn origin_peer_host_and_duplicate_cookie_checks_fail_closed() {
    let f = Fixture::new().await;
    let user = f.register("user@example.test", false).await;
    let cookie = user.cookie();
    for headers in [
        vec![("origin", "https://attacker.example")],
        vec![("sec-fetch-site", "cross-site")],
    ] {
        let reply = request(
            &f.app,
            "GET",
            "/api/account/session",
            &cookie,
            None,
            &headers,
        )
        .await;
        assert_eq!(reply.status, 403);
        assert_eq!(reply.headers["cache-control"], "no-store");
        assert_eq!(reply.headers["x-content-type-options"], "nosniff");
    }
    let duplicate = format!("{cookie}; {cookie}");
    assert_eq!(
        f.request("GET", "/api/account/session", &duplicate, None)
            .await
            .value["authenticated"],
        false
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/account/workspaces",
            &duplicate,
            Some(json!({"name":"blocked"}))
        )
        .await
        .status,
        401
    );
    let req = Request::builder()
        .uri("/api/health")
        .header("host", "127.0.0.1:3002")
        .body(Body::empty())
        .unwrap();
    assert_eq!(f.app.clone().oneshot(req).await.unwrap().status(), 403);
    assert_eq!(
        f.request("GET", "/api/not-implemented", &cookie, None)
            .await
            .status,
        404
    );
    f.state.close().await;
}

#[tokio::test]
async fn remote_mode_requires_fixed_https_origin_and_host_cookie() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = openbot_backend::config::Config::local(dir.path());
    config.public_origin = Some("https://bots.example.test".into());
    let state = openbot_backend::db::State::open(config).await.unwrap();
    let app = openbot_backend::router(state.clone());
    let send = |method: &str, origin: Option<&str>| {
        let mut req = Request::builder()
            .method(method)
            .uri(if method == "GET" {
                "/api/account/session"
            } else {
                "/api/account/logout"
            })
            .header("host", "bots.example.test");
        if let Some(origin) = origin {
            req = req.header("origin", origin);
        }
        let mut req = req.body(Body::empty()).unwrap();
        req.extensions_mut().insert(axum::extract::ConnectInfo(
            "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
        req
    };
    assert_eq!(
        app.clone()
            .oneshot(send("POST", None))
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        app.clone()
            .oneshot(send("POST", Some("https://evil.example")))
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        app.clone()
            .oneshot(send("GET", None))
            .await
            .unwrap()
            .status(),
        200
    );
    let result = app
        .clone()
        .oneshot(send("POST", Some("https://bots.example.test")))
        .await
        .unwrap();
    assert_eq!(result.status(), 200);
    let cookie = result.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("__Host-openbot_account="));
    assert!(cookie.ends_with("; Secure"));
    assert_eq!(
        result.headers()["content-security-policy"],
        "frame-ancestors 'none'"
    );
    state.close().await;
}

#[tokio::test]
async fn malformed_bodies_and_login_attempts_are_bounded() {
    let f = Fixture::new().await;
    assert_eq!(
        f.request(
            "POST",
            "/api/account/register",
            "",
            Some(json!({"email":"invalid","name":"x","password":"password-123","kind":"personal"}))
        )
        .await
        .status,
        400
    );
    let too_large = json!({"padding":"a".repeat(66000)});
    assert_eq!(
        f.request("POST", "/api/account/register", "", Some(too_large))
            .await
            .status,
        413
    );
    for _ in 0..12 {
        assert_eq!(
            f.request(
                "POST",
                "/api/account/login",
                "",
                Some(json!({"email":"invalid"}))
            )
            .await
            .status,
            400
        );
    }
    assert_eq!(
        f.request(
            "POST",
            "/api/account/login",
            "",
            Some(json!({"email":"invalid"}))
        )
        .await
        .status,
        429
    );
    f.state.close().await;
}
