use super::{
    release::ReleaseClient,
    valid_repository,
    version::{Version, status},
};
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

pub(super) fn release(tag: &str) -> Value {
    json!({"tag_name":tag,"name":"Synthetic release","body":"Synthetic release notes","draft":false,"prerelease":false,"published_at":"2026-11-01T00:00:00Z","html_url":format!("https://github.com/synthetic-org/openbot-example/releases/tag/{tag}")})
}
pub(super) async fn mock(
    status: u16,
    body: String,
    delay: Duration,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let app = Router::new()
        .route(
            "/latest",
            get(move |headers: HeaderMap| {
                let count = count.clone();
                let body = body.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    assert!(!headers.contains_key("authorization"));
                    assert!(!headers.contains_key("cookie"));
                    assert_eq!(headers["accept"], "application/vnd.github+json");
                    tokio::time::sleep(delay).await;
                    Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .header("location", "/unexpected")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        )
        .route(
            "/unexpected",
            get(|| async {
                panic!("redirect must never be followed");
                #[allow(unreachable_code)]
                StatusCode::OK
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}/latest"), calls, task)
}
#[test]
fn semver_compares_numeric_and_prerelease_components_strictly() {
    for (current, latest, expected) in [
        ("1.9.0", "1.10.0", "update_available"),
        ("1.0.0-rc.1", "1.0.0", "update_available"),
        ("1.0.0+build.2", "1.0.0+build.3", "current"),
        ("2.0.0", "1.10.0", "current"),
        ("01.0.0", "2.0.0", "unknownVersion"),
        ("1.0.0", "2.0.0-beta", "unknownVersion"),
    ] {
        assert_eq!(status(current, Some(latest)), expected);
    }
    for value in [
        "1",
        "1.2",
        "v1.2.3",
        "1.2.3-01",
        "1.2.3+",
        "1.2.3-a..b",
        "1.2.3+a+b",
        " 1.2.3",
        "1.2.3\n",
    ] {
        assert!(Version::parse(value).is_none(), "{value}");
    }
    assert!(
        Version::parse("1.0.0-alpha.9")
            .unwrap()
            .compare(&Version::parse("1.0.0-alpha.10").unwrap())
            .is_lt()
    );
    assert!(
        Version::parse("1.0.0-9")
            .unwrap()
            .compare(&Version::parse("1.0.0-alpha").unwrap())
            .is_lt()
    );
}
#[test]
fn repository_configuration_is_a_slug_not_a_url_or_private_target() {
    assert!(valid_repository("synthetic-org/openbot-example"));
    for value in [
        "https://github.com/a/b",
        "a/b/c",
        "a/b?token=x",
        "a/%2e%2e",
        "a/..",
        "-owner/repo",
        "owner-/repo",
        "a--b/repo",
        "127.0.0.1/repo",
        "a/space repo",
        "a/repo#fragment",
        "a/@repo",
    ] {
        assert!(!valid_repository(value), "{value}");
    }
    let directory = tempfile::tempdir().unwrap();
    let mut config = crate::config::Config::local(directory.path());
    config.releases = Some(super::ReleasesConfig {
        repository: "https://example.test/private".into(),
    });
    assert!(config.validate().is_err());
}
#[tokio::test]
async fn real_http_release_fetch_rejects_unstable_invalid_urls_oversize_and_redirects() {
    let mut unstable = release("v2.0.0");
    unstable["prerelease"] = true.into();
    let mut draft = release("v2.0.0");
    draft["draft"] = true.into();
    let mut bad_url = release("v2.0.0");
    bad_url["html_url"] = "https://example.test/untrusted".into();
    let mut canonical_case = release("v2.0.0");
    canonical_case["html_url"] =
        "https://github.com/Synthetic-Org/OpenBot-Example/releases/tag/v2.0.0".into();
    for (code, body, expected) in [
        (200, release("v2.0.0").to_string(), None),
        (200, canonical_case.to_string(), None),
        (200, release("latest-stable").to_string(), None),
        (200, unstable.to_string(), Some("invalid_release")),
        (200, draft.to_string(), Some("invalid_release")),
        (200, release("..").to_string(), Some("invalid_release")),
        (200, bad_url.to_string(), Some("invalid_release")),
        (200, "x".repeat(256 * 1024 + 1), Some("response_too_large")),
        (302, release("v2.0.0").to_string(), Some("network")),
        (404, "{}".into(), Some("not_found")),
        (429, "{}".into(), Some("rate_limited")),
    ] {
        let (url, calls, task) = mock(code, body, Duration::ZERO).await;
        let result = ReleaseClient::fixture(url, Duration::from_secs(1))
            .fetch("synthetic-org/openbot-example")
            .await;
        match expected {
            Some(error) => assert_eq!(result.err(), Some(error)),
            None => assert!(result.is_ok()),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
        let _ = task.await;
    }
}
#[tokio::test]
async fn real_http_release_timeout_has_a_bounded_safe_reason() {
    let (url, _, task) = mock(
        200,
        release("v2.0.0").to_string(),
        Duration::from_millis(250),
    )
    .await;
    assert_eq!(
        ReleaseClient::fixture(url, Duration::from_millis(25))
            .fetch("synthetic-org/openbot-example")
            .await
            .err(),
        Some("timeout")
    );
    task.abort();
    let _ = task.await;
}

#[test]
fn private_config_accepts_only_repository_and_never_a_custom_endpoint_or_token() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("server.private.json");
    for (releases, valid) in [
        (json!({"repository":"synthetic-org/openbot-example"}), true),
        (Value::Null, true),
        (
            json!({"repository":"synthetic-org/openbot-example","endpoint":"http://127.0.0.1:9"}),
            false,
        ),
        (
            json!({"repository":"synthetic-org/openbot-example","token":"SYNTHETIC_NOT_USED"}),
            false,
        ),
    ] {
        std::fs::write(
            &path,
            json!({"dataDir":directory.path().join("data"),"releases":releases}).to_string(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            crate::config::Config::from_private_file(&path).is_ok(),
            valid
        );
    }
}
