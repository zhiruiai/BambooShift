use openbot_backend::{
    config::{Config, OperationsConfig},
    db::State,
    operations_router, product_router,
};
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};
use tokio::{net::TcpListener, task::JoinHandle};

struct Fixture {
    _directory: tempfile::TempDir,
    state: State,
    product: String,
    operations: String,
    client: reqwest::Client,
    servers: Vec<JoinHandle<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let runtime = directory.path().join("runtime");
        for (name, text) in [("dist", "PRODUCT"), ("operations-dist", "OPERATIONS")] {
            std::fs::create_dir_all(runtime.join(name).join("assets")).unwrap();
            std::fs::write(runtime.join(name).join("index.html"), text).unwrap();
            std::fs::write(runtime.join(name).join("assets/app.js"), text).unwrap();
        }
        std::os::unix::fs::symlink(
            runtime.join("operations-dist/index.html"),
            runtime.join("dist/leak.html"),
        )
        .unwrap();
        let product = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let operations = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = Config::local(directory.path().join("data"));
        config.runtime_dir = runtime;
        config.bind = product.local_addr().unwrap();
        config.web_origin = Some("http://127.0.0.1:5173".into());
        config.operations = Some(OperationsConfig {
            bind: operations.local_addr().unwrap(),
            public_origin: None,
            web_origin: Some("http://127.0.0.1:5174".into()),
        });
        let product_url = format!("http://{}", config.bind);
        let operations_url = format!("http://{}", config.operations.as_ref().unwrap().bind);
        let state = State::open(config).await.unwrap();
        let mut servers = vec![];
        for (listener, app) in [
            (product, product_router(state.clone())),
            (operations, operations_router(state.clone())),
        ] {
            servers.push(tokio::spawn(async move {
                axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await
                .unwrap();
            }));
        }
        Self {
            _directory: directory,
            state,
            product: product_url,
            operations: operations_url,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            servers,
        }
    }
    async fn close(self) {
        self.state.close().await;
        for server in self.servers {
            server.abort();
            let _ = server.await;
        }
    }
    async fn post(&self, base: &str, path: &str, cookie: &str, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{base}{path}"))
            .header("cookie", cookie)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
}
fn cookie(reply: &reqwest::Response) -> String {
    reply.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}

#[tokio::test]
async fn real_listeners_separate_routes_and_static_assets_with_fixed_admin_redirect() {
    let f = Fixture::new().await;
    for (base, paths, expected) in [
        (&f.product, vec!["/", "/login", "/assets/app.js"], "PRODUCT"),
        (
            &f.operations,
            vec![
                "/",
                "/admin",
                "/admin/login",
                "/admin/setup",
                "/admin/users",
                "/assets/app.js",
            ],
            "OPERATIONS",
        ),
    ] {
        for path in paths {
            let response = f.client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), 200, "{path}");
            assert_eq!(response.text().await.unwrap(), expected);
        }
    }
    for (base, paths) in [
        (
            &f.product,
            vec![
                "/api/platform/session",
                "/api/platform/users",
                "/operations-dist/index.html",
                "/leak.html",
            ],
        ),
        (
            &f.operations,
            vec![
                "/api/account/session",
                "/api/account/register",
                "/api/workspaces/unknown/bootstrap",
                "/api/routine-operations",
                "/login",
                "/register",
                "/w/unknown",
            ],
        ),
    ] {
        for path in paths {
            let response = f.client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), 404, "{path}");
        }
    }
    for (base, path) in [
        (&f.product, "/api/platform/login"),
        (&f.operations, "/api/account/register"),
    ] {
        assert_eq!(f.post(base, path, "", json!({})).await.status(), 404);
    }
    let redirected = f
        .client
        .get(format!("{}/admin/login?next=%2Fadmin", f.product))
        .send()
        .await
        .unwrap();
    assert_eq!(redirected.status(), 307);
    assert_eq!(
        redirected.headers()["location"],
        "http://127.0.0.1:5174/admin/login?next=%2Fadmin"
    );
    assert_eq!(
        f.post(&f.product, "/admin/login", "", json!({}))
            .await
            .status(),
        404
    );
    f.close().await;
}

#[tokio::test]
async fn operations_uses_its_own_origins_and_rejects_product_host_and_cross_site_fetch() {
    let f = Fixture::new().await;
    for origin in [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        &f.product,
        "https://evil.example.test",
        "null",
    ] {
        assert_eq!(
            f.client
                .get(format!("{}/api/platform/session", f.operations))
                .header("origin", origin)
                .send()
                .await
                .unwrap()
                .status(),
            403,
            "{origin}"
        );
    }
    for origin in ["http://127.0.0.1:5174", &f.operations] {
        assert_eq!(
            f.client
                .get(format!("{}/api/platform/session", f.operations))
                .header("origin", origin)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        f.client
            .get(format!("{}/api/platform/session", f.operations))
            .header("host", f.product.strip_prefix("http://").unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        f.client
            .get(format!("{}/api/health", f.product))
            .header("origin", "http://127.0.0.1:5174")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        f.client
            .get(format!("{}/api/platform/session", f.operations))
            .header("sec-fetch-site", "cross-site")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let navigation = f
        .client
        .get(format!("{}/admin/login", f.operations))
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .header("accept", "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(navigation.status(), 200);
    assert_eq!(navigation.headers()["x-frame-options"], "DENY");
    f.close().await;
}

#[tokio::test]
async fn independent_sessions_share_identity_data_without_cross_purpose_authority() {
    let f = Fixture::new().await;
    let user = f.post(&f.product, "/api/account/register", "", json!({"email":"member@example.test","name":"Synthetic member","password":"synthetic-password-42","kind":"personal"})).await;
    assert_eq!(user.status(), 201);
    let user_cookie = cookie(&user);
    let user_id = user.json::<Value>().await.unwrap()["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        f.client
            .get(format!("{}/api/platform/users", f.operations))
            .header("cookie", &user_cookie)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let renamed = user_cookie.replace("openbot_account=", "openbot_operator=");
    assert_eq!(
        f.client
            .get(format!("{}/api/platform/users", f.operations))
            .header("cookie", renamed)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        f.post(
            &f.operations,
            "/api/platform/login",
            "",
            json!({"email":"member@example.test","password":"synthetic-password-42"})
        )
        .await
        .status(),
        401
    );
    let setup_file = f.state.provision_operator().await.unwrap();
    let setup = std::fs::read_to_string(setup_file).unwrap();
    let operator = f.post(&f.operations, "/api/platform/setup", "", json!({"code":setup.trim(),"email":"operator@example.test","name":"Synthetic operator","password":"synthetic-password-42"})).await;
    assert_eq!(operator.status(), 201);
    let operator_cookie = cookie(&operator);
    let session = f
        .client
        .get(format!("{}/api/account/session", f.product))
        .header("cookie", &operator_cookie)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(session["authenticated"], false);
    let users = f
        .client
        .get(format!("{}/api/platform/users", f.operations))
        .header("cookie", &operator_cookie)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert!(
        users.to_string().contains(&user_id),
        "both listeners use the same identity database"
    );
    assert_eq!(
        f.post(&f.product, "/api/account/logout", &user_cookie, json!({}))
            .await
            .status(),
        200
    );
    let session = f
        .client
        .get(format!("{}/api/platform/session", f.operations))
        .header("cookie", &operator_cookie)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(session["authenticated"], true);
    f.close().await;
}

#[tokio::test]
async fn missing_operations_configuration_has_no_product_admin_page() {
    let directory = tempfile::tempdir().unwrap();
    let state = State::open(Config::local(directory.path())).await.unwrap();
    use axum::{body::Body, extract::ConnectInfo, http::Request};
    use tower::ServiceExt;
    let mut request = Request::builder()
        .uri("/admin/login")
        .header("host", "127.0.0.1:3002")
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
    ));
    assert_eq!(
        product_router(state.clone())
            .oneshot(request)
            .await
            .unwrap()
            .status(),
        404
    );
    state.close().await;
}

#[test]
fn distinct_https_cookie_configuration_does_not_cross_product_and_operations() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::local(dir.path());
    config.operations = Some(OperationsConfig {
        bind: "127.0.0.1:3003".parse().unwrap(),
        public_origin: Some("https://operations.example.test".into()),
        web_origin: None,
    });
    config.validate().unwrap();
    assert!(
        config
            .cookie("operator", "synthetic")
            .starts_with("__Host-openbot_operator=")
    );
    assert!(config.cookie("operator", "synthetic").ends_with("; Secure"));
    assert!(
        config
            .cookie("account", "synthetic")
            .starts_with("openbot_account=")
    );
    config.public_origin = Some("https://product.example.test".into());
    config.operations.as_mut().unwrap().public_origin = None;
    assert!(
        config
            .cookie("account", "synthetic")
            .starts_with("__Host-openbot_account=")
    );
    assert!(!config.cookie("operator", "synthetic").ends_with("; Secure"));
    config.operations.as_mut().unwrap().bind = config.bind;
    assert!(config.validate().is_err());
}

#[tokio::test]
async fn https_operations_origin_and_host_remain_independent_of_product_proxy() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut config = Config::local(directory.path());
    config.public_origin = Some("https://product.example.test".into());
    config.operations = Some(OperationsConfig {
        bind: address,
        public_origin: Some("https://operations.example.test".into()),
        web_origin: None,
    });
    let state = State::open(config).await.unwrap();
    let app = operations_router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    for (host, origin, expected) in [
        ("operations.example.test", None, 403),
        (
            "operations.example.test",
            Some("https://product.example.test"),
            403,
        ),
        (
            "product.example.test",
            Some("https://operations.example.test"),
            403,
        ),
        (
            "operations.example.test",
            Some("https://operations.example.test"),
            200,
        ),
    ] {
        let mut request = client
            .post(format!("http://{address}/api/platform/logout"))
            .header("host", host);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), expected);
        if expected == 200 {
            let cookie = response.headers()["set-cookie"].to_str().unwrap();
            assert!(cookie.starts_with("__Host-openbot_operator="));
            assert!(cookie.ends_with("; Secure"));
        }
    }
    state.close().await;
    server.abort();
    let _ = server.await;
}
