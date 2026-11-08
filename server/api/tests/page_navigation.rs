use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use openbot_backend::{config::Config, db::State, router};
use sqlx::{Row, SqlitePool};
use tower::ServiceExt;

const TEAM_SKILL_PAGE: &str = "/team-skills/01234567-89ab-4cde-8f01-23456789abcd/01234567-89ab-4cde-8f01-23456789abcd/01234567-89ab-4cde-8f01-23456789abcd";
const TEAM_SKILL_API: &str = "/api/workspaces/01234567-89ab-4cde-8f01-23456789abcd/team-skills/01234567-89ab-4cde-8f01-23456789abcd/link/01234567-89ab-4cde-8f01-23456789abcd";

struct PageFixture {
    directory: tempfile::TempDir,
    state: State,
    database: SqlitePool,
}
impl PageFixture {
    async fn new(public: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let runtime = directory.path().join("runtime");
        std::fs::create_dir_all(runtime.join("dist")).unwrap();
        std::fs::write(runtime.join("dist/index.html"), "<!doctype html><html><title>Synthetic OpenBot account UI</title><main id=app></main></html>").unwrap();
        let mut config = Config::local(directory.path().join("private-data"));
        config.runtime_dir = runtime;
        if public {
            config.public_origin = Some("https://openbot.example.test".into());
        }
        let state = State::open(config).await.unwrap();
        let database = SqlitePool::connect(&format!(
            "sqlite:{}",
            directory
                .path()
                .join("private-data/platform/identity.sqlite")
                .display()
        ))
        .await
        .unwrap();
        Self {
            directory,
            state,
            database,
        }
    }
    fn request(&self, method: &str, path: &str, body: Body) -> Request<Body> {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(
                "host",
                if self.state.config.public_origin.is_some() {
                    "openbot.example.test"
                } else {
                    "127.0.0.1:3002"
                },
            )
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .header("accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
            .body(body)
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:45555".parse::<std::net::SocketAddr>().unwrap(),
        ));
        request
    }
    async fn counts(&self) -> Vec<(String, i64)> {
        let mut output = vec![];
        for row in sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&self.database).await.unwrap() {
            let name: String = row.get("name");
            let query = format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\""));
            let count: i64 = sqlx::query_scalar(&query).fetch_one(&self.database).await.unwrap();
            output.push((name, count));
        }
        output
    }
    async fn close(self) {
        self.database.close().await;
        self.state.close().await;
    }
}

#[tokio::test]
async fn real_cross_site_account_invitation_and_shared_bot_navigation_serves_only_the_public_html()
{
    for public in [false, true] {
        let f = PageFixture::new(public).await;
        let before = f.counts().await;
        let token = "a".repeat(43);
        for path in [
            "/login".to_owned(),
            "/register".to_owned(),
            format!("/invite/{token}"),
            "/shared-bots/01234567-89ab-4cde-8f01-23456789abcd".to_owned(),
            TEAM_SKILL_PAGE.to_owned(),
            format!("/login?next=%2Finvite%2F{token}"),
            "/register?next=https%3A%2F%2Fevil.example.test".to_owned(),
        ] {
            let response = router(f.state.clone())
                .oneshot(f.request("GET", &path, Body::empty()))
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "public={public} path={path}");
            assert_eq!(
                response.headers()["content-type"],
                "text/html; charset=utf-8"
            );
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.headers()["referrer-policy"], "no-referrer");
            if path == TEAM_SKILL_PAGE {
                assert_eq!(response.headers()["x-frame-options"], "DENY");
                assert_eq!(
                    response.headers()["x-robots-tag"],
                    "noindex, nofollow, noarchive"
                );
            }
            assert!(!response.headers().contains_key("set-cookie"));
            assert!(
                !response.headers().contains_key("location"),
                "the shell never follows an unsanitized next value"
            );
            assert_eq!(to_bytes(response.into_body(), 1000).await.unwrap().as_ref(), b"<!doctype html><html><title>Synthetic OpenBot account UI</title><main id=app></main></html>");
        }
        assert_eq!(
            f.counts().await,
            before,
            "navigation creates no account, membership, session or workspace"
        );
        assert!(!f.directory.path().join("private-data/spaces").exists());
        f.close().await;
    }
}

#[tokio::test]
async fn cross_site_navigation_exception_never_admits_fetch_iframe_bodies_mutations_or_api_calls() {
    let f = PageFixture::new(false).await;
    let before = f.counts().await;
    let token = "a".repeat(43);
    for (method, path) in [
        ("POST", "/register".to_owned()),
        ("HEAD", "/login".to_owned()),
        ("GET", "/api/account/session".to_owned()),
        ("GET", TEAM_SKILL_API.to_owned()),
        ("GET", format!("{TEAM_SKILL_PAGE}/")),
        ("GET", TEAM_SKILL_PAGE.replace("01234567", "abcdefg0")),
        ("POST", "/api/account/register".to_owned()),
        ("GET", format!("/api/invites/{token}")),
        ("GET", "/invite/short".to_owned()),
        ("GET", format!("/invite/{token}/")),
        ("GET", format!("/invite/{}!", "a".repeat(42))),
        ("GET", "/shared-bots/not-a-uuid".to_owned()),
        (
            "GET",
            "/shared-bots/0123456789ab4cde8f0123456789abcd".to_owned(),
        ),
        ("GET", "/admin".to_owned()),
        ("GET", "/login/".to_owned()),
    ] {
        let response = router(f.state.clone())
            .oneshot(f.request(method, &path, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), 403, "{method} {path}");
    }
    for (header, value) in [
        ("sec-fetch-mode", None),
        ("sec-fetch-mode", Some("cors")),
        ("sec-fetch-dest", None),
        ("sec-fetch-dest", Some("iframe")),
        ("accept", None),
        ("accept", Some("application/json")),
        ("content-length", Some("1")),
        ("transfer-encoding", Some("chunked")),
    ] {
        for path in ["/login", TEAM_SKILL_PAGE] {
            let mut request = f.request("GET", path, Body::empty());
            if let Some(value) = value {
                request.headers_mut().insert(header, value.parse().unwrap());
            } else {
                request.headers_mut().remove(header);
            }
            let response = router(f.state.clone()).oneshot(request).await.unwrap();
            let expected = if path == TEAM_SKILL_PAGE
                && matches!(header, "content-length" | "transfer-encoding")
            {
                400
            } else {
                403
            };
            assert_eq!(response.status(), expected, "{path} {header}={value:?}");
        }
    }
    let response = router(f.state.clone())
        .oneshot(f.request("GET", "/register", Body::from("unexpected body")))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        403,
        "a body without a length header is also rejected"
    );
    assert_eq!(f.counts().await, before);
    f.close().await;
}

#[tokio::test]
async fn permitted_html_navigation_retains_host_peer_and_explicit_origin_pins() {
    for public in [false, true] {
        let f = PageFixture::new(public).await;
        for (header, value) in [
            ("host", "evil.example.test"),
            ("origin", "https://external.example.test"),
            ("origin", "null"),
        ] {
            let mut request = f.request("GET", "/login", Body::empty());
            request.headers_mut().insert(header, value.parse().unwrap());
            assert_eq!(
                router(f.state.clone())
                    .oneshot(request)
                    .await
                    .unwrap()
                    .status(),
                403
            );
        }
        let mut request = f.request("GET", "/register", Body::empty());
        request.extensions_mut().insert(ConnectInfo(
            "192.0.2.10:45555".parse::<std::net::SocketAddr>().unwrap(),
        ));
        assert_eq!(
            router(f.state.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            403
        );
        f.close().await;
    }
}

#[tokio::test]
async fn real_http_invitation_navigation_with_no_body_reaches_the_html_shell() {
    let f = PageFixture::new(false).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = f.state.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .get(format!("http://{address}/invite/{}", "a".repeat(43)))
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .header("accept", "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(
        response
            .text()
            .await
            .unwrap()
            .contains("Synthetic OpenBot account UI")
    );
    assert!(f.counts().await.into_iter().all(|(_, count)| count == 0));
    server.abort();
    let _ = server.await;
    f.close().await;
}
