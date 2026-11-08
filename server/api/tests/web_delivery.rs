use axum::{body::Body, extract::ConnectInfo, http::Request};
use http_body_util::BodyExt;
use openbot_backend::{config::Config, db::State, router};
use std::os::unix::fs::symlink;
use tower::ServiceExt;

#[tokio::test]
async fn rust_serves_built_ui_and_deep_links_without_exposing_private_or_linked_files() {
    let root = tempfile::tempdir().unwrap();
    let public = root.path().join("dist");
    std::fs::create_dir_all(public.join("assets")).unwrap();
    std::fs::write(
        public.join("index.html"),
        "<!doctype html><title>Synthetic UI</title>",
    )
    .unwrap();
    std::fs::write(public.join("assets/app.js"), "document.title='Synthetic';").unwrap();
    std::fs::write(
        public.join("manifest.webmanifest"),
        "{\"name\":\"Synthetic manifest\"}",
    )
    .unwrap();
    let private = root.path().join("private.json");
    std::fs::write(&private, "private-synthetic-sentinel").unwrap();
    symlink(&private, public.join("assets/linked.js")).unwrap();
    symlink(root.path(), public.join("redirected")).unwrap();
    std::fs::write(public.join("assets/app.js.map"), "private-source-map").unwrap();
    let mut config = Config::local(root.path().join("data"));
    config.runtime_dir = root.path().to_owned();
    let state = State::open(config).await.unwrap();
    let app = router(state.clone());
    for (method, path, status, expected) in [
        ("GET", "/", 200, "Synthetic UI"),
        ("GET", "/admin/setup", 200, "Synthetic UI"),
        ("GET", "/register", 200, "Synthetic UI"),
        (
            "GET",
            "/templates/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
            200,
            "Synthetic UI",
        ),
        ("GET", "/assets/app.js", 200, "document.title"),
        ("HEAD", "/assets/app.js", 200, ""),
        ("GET", "/manifest.webmanifest", 200, "Synthetic manifest"),
        ("GET", "/assets/linked.js", 404, ""),
        ("GET", "/redirected/private.json", 404, ""),
        ("GET", "/assets/app.js.map", 404, ""),
        ("GET", "/.env", 404, ""),
        ("GET", "/%2e%2e/private.json", 404, ""),
        ("GET", "/api/unknown", 404, ""),
        ("POST", "/register", 404, ""),
    ] {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost:3002")
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:41234".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let reply = app.clone().oneshot(request).await.unwrap();
        assert_eq!(reply.status().as_u16(), status, "{method} {path}");
        if status == 200 {
            assert!(
                reply.headers()["content-type"]
                    .to_str()
                    .unwrap()
                    .starts_with(if path.ends_with(".js") {
                        "text/javascript"
                    } else if path.ends_with(".webmanifest") {
                        "application/manifest+json"
                    } else {
                        "text/html"
                    })
            );
        }
        let bytes = reply.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!text.contains("private-synthetic-sentinel"));
        if method == "HEAD" {
            assert!(text.is_empty());
        } else if status == 200 {
            assert!(text.contains(expected));
        }
    }
    state.close().await;
}
