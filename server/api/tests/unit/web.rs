use crate::{
    config::{Config, OperationsConfig},
    db::State,
};
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use std::{fs, net::SocketAddr, path::PathBuf};
use tower::ServiceExt;

struct Fixture {
    state: State,
    runtime: PathBuf,
    _directory: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let runtime = directory.path().join("runtime");
        for public in ["dist", "operations-dist"] {
            fs::create_dir_all(runtime.join(public).join("assets")).unwrap();
            fs::write(runtime.join(public).join("index.html"), public).unwrap();
        }
        fs::write(
            runtime.join("dist/assets/app.js"),
            "export const ready = true;",
        )
        .unwrap();
        fs::write(runtime.join("operations-dist/assets/app.js"), "operations").unwrap();
        let mut config = Config::local(directory.path().join("data"));
        config.runtime_dir = runtime.clone();
        config.operations = Some(OperationsConfig {
            bind: "127.0.0.1:3003".parse().unwrap(),
            public_origin: None,
            web_origin: None,
        });
        Self {
            state: State::open(config).await.unwrap(),
            runtime,
            _directory: directory,
        }
    }

    async fn request(
        &self,
        operations: bool,
        method: &str,
        path: &str,
    ) -> (u16, HeaderMap, Vec<u8>) {
        let router = if operations {
            crate::operations_router(self.state.clone())
        } else {
            crate::product_router(self.state.clone())
        };
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(
                "host",
                if operations {
                    "127.0.0.1:3003"
                } else {
                    "127.0.0.1:3002"
                },
            )
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:44000".parse::<SocketAddr>().unwrap(),
        ));
        let response = router.oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 11 * 1024 * 1024)
            .await
            .unwrap();
        (status, headers, bytes.to_vec())
    }

    async fn missing(&self, path: &str) {
        assert_eq!(self.request(false, "GET", path).await.0, 404, "{path}");
    }
}

#[tokio::test]
async fn product_and_operations_routes_serve_their_own_assets_with_get_and_head() {
    let fixture = Fixture::new().await;
    for (operations, expected) in [(false, "export const ready = true;"), (true, "operations")] {
        let (status, headers, bytes) = fixture.request(operations, "GET", "/assets/app.js").await;
        assert_eq!(status, 200);
        assert_eq!(headers["content-type"], "text/javascript; charset=utf-8");
        assert_eq!(headers["content-length"], expected.len().to_string());
        assert_eq!(bytes, expected.as_bytes());
        let (status, headers, bytes) = fixture.request(operations, "HEAD", "/assets/app.js").await;
        assert_eq!(status, 200);
        assert_eq!(headers["content-length"], expected.len().to_string());
        assert!(bytes.is_empty());
    }
    assert_eq!(fixture.request(false, "GET", "/login").await.2, b"dist");
    assert_eq!(
        fixture.request(true, "GET", "/admin/setup").await.2,
        b"operations-dist"
    );
    fixture.missing("/operations-dist/assets/app.js").await;
    fixture.state.close().await;
}

#[tokio::test]
async fn static_routes_reject_traversal_hidden_files_and_non_public_extensions() {
    let fixture = Fixture::new().await;
    fs::write(fixture.runtime.join("canary.js"), "private canary").unwrap();
    fs::write(fixture.runtime.join("dist/.private.js"), "private").unwrap();
    fs::write(
        fixture.runtime.join("dist/assets/app.js.map"),
        "private map",
    )
    .unwrap();
    // This is an NTFS alternate stream on Windows and a colon-named file on Unix.
    fs::write(
        fixture.runtime.join("dist/assets/app.js:stream.js"),
        "private stream",
    )
    .unwrap();
    for path in [
        "/../canary.js",
        "/assets/../../canary.js",
        "/assets/%2e%2e/%2e%2e/canary.js",
        "/assets\\..\\canary.js",
        "/assets//app.js",
        "/.private.js",
        "/assets/app.js.map",
        "/C:/canary.js",
        "/assets/app.js:stream.js",
        "/api/not-a-route.js",
    ] {
        fixture.missing(path).await;
    }
    assert_eq!(
        fixture.request(false, "POST", "/assets/app.js").await.0,
        404
    );
    assert_eq!(
        fs::read(fixture.runtime.join("canary.js")).unwrap(),
        b"private canary"
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn static_routes_reject_directories_and_files_over_the_read_limit() {
    let fixture = Fixture::new().await;
    fs::create_dir(fixture.runtime.join("dist/directory.js")).unwrap();
    let oversized = fs::File::create(fixture.runtime.join("dist/large.js")).unwrap();
    oversized.set_len(10 * 1024 * 1024 + 1).unwrap();
    let at_limit = fs::File::create(fixture.runtime.join("dist/limit.js")).unwrap();
    at_limit.set_len(10 * 1024 * 1024).unwrap();
    fixture.missing("/directory.js").await;
    fixture.missing("/large.js").await;
    let (status, headers, bytes) = fixture.request(false, "HEAD", "/limit.js").await;
    assert_eq!(status, 200);
    assert_eq!(headers["content-length"], "10485760");
    assert!(bytes.is_empty());
    fixture.state.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn static_routes_reject_root_parent_and_final_symlinks_even_inside_the_public_tree() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new().await;
    let dist = fixture.runtime.join("dist");
    fs::create_dir(fixture.runtime.join("private")).unwrap();
    fs::write(fixture.runtime.join("private/canary.js"), "private canary").unwrap();
    symlink(fixture.runtime.join("private"), dist.join("outside")).unwrap();
    symlink("assets", dist.join("inside")).unwrap();
    symlink("assets/app.js", dist.join("linked.js")).unwrap();
    symlink("../private/canary.js", dist.join("outside.js")).unwrap();
    for path in [
        "/outside/canary.js",
        "/inside/app.js",
        "/linked.js",
        "/outside.js",
    ] {
        fixture.missing(path).await;
    }
    fs::rename(&dist, fixture.runtime.join("original-dist")).unwrap();
    symlink("original-dist", &dist).unwrap();
    fixture.missing("/assets/app.js").await;
    assert_eq!(
        fs::read(fixture.runtime.join("private/canary.js")).unwrap(),
        b"private canary"
    );
    fixture.state.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn static_routes_reject_a_fifo_instead_of_serving_it_as_javascript() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let fixture = Fixture::new().await;
    let fifo = fixture.runtime.join("dist/pipe.js");
    let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    // Keep a writer attached so a regression cannot hang the test before the regular-file check.
    let _peer = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(fifo)
        .unwrap();
    fixture.missing("/pipe.js").await;
    fixture.state.close().await;
}
