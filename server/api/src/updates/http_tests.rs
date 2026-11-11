use super::{
    ReleasesConfig, Updates,
    release::ReleaseClient,
    tests::{mock, release},
};
use crate::{config::Config, db::State};
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    net::SocketAddr,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tower::ServiceExt;
struct Fixture {
    state: State,
    _directory: tempfile::TempDir,
    owner: String,
    member: String,
    wid: String,
}
impl Fixture {
    async fn new(url: Option<String>) -> Self {
        Self::with_repository(url, "synthetic-org/openbot-example").await
    }
    async fn with_repository(url: Option<String>, repository: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut config = Config::local(directory.path());
        if url.is_some() {
            config.releases = Some(ReleasesConfig {
                repository: repository.into(),
            });
        }
        let mut state = State::open(config).await.unwrap();
        if let Some(url) = url {
            state.updates = Arc::new(Updates {
                client: Some(ReleaseClient::fixture(url, Duration::from_secs(1))),
                ..Updates::default()
            });
        }
        let owner = uuid::Uuid::new_v4().to_string();
        let member = uuid::Uuid::new_v4().to_string();
        let wid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO workspaces VALUES(?,'Synthetic','team','active',?,1)")
            .bind(&wid)
            .bind(&wid)
            .execute(&state.pool)
            .await
            .unwrap();
        for (user, role, token) in [(&owner, "owner", "o"), (&member, "member", "m")] {
            sqlx::query("INSERT INTO users VALUES(?,?,?,'synthetic-only','active','user',1)")
                .bind(user)
                .bind(format!("{role}@example.test"))
                .bind(role)
                .execute(&state.pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO memberships VALUES(?,?,?,1)")
                .bind(&wid)
                .bind(user)
                .bind(role)
                .execute(&state.pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO account_sessions VALUES(?,?,?,'account','Synthetic',1,?)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(hex::encode(Sha256::digest(token.repeat(43).as_bytes())))
                .bind(user)
                .bind(crate::db::now() + 60000)
                .execute(&state.pool)
                .await
                .unwrap();
        }
        Self {
            state,
            _directory: directory,
            owner,
            member,
            wid,
        }
    }
    async fn request(&self, method: &str, member: bool, expected: Option<&str>) -> (u16, Value) {
        request(self.state.clone(), &self.wid, method, member, expected).await
    }
}
async fn request(
    state: State,
    wid: &str,
    method: &str,
    member: bool,
    expected: Option<&str>,
) -> (u16, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/api/workspaces/{wid}/updates"))
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header("content-type", "application/json")
        .header(
            "cookie",
            format!(
                "openbot_account={}",
                if member { "m" } else { "o" }.repeat(43)
            ),
        );
    if let Some(expected) = expected {
        request = request.header("X-OpenBot-Expected-User", expected);
    }
    let mut request = request
        .body(Body::from(if method == "POST" { "{}" } else { "" }))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:44000".parse::<SocketAddr>().unwrap(),
    ));
    let response = crate::product_router(state).oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
async fn entered(calls: &Arc<std::sync::atomic::AtomicUsize>) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn status_is_offline_unconfigured_and_checks_require_fixed_workspace_account() {
    let f = Fixture::new(None).await;
    assert_eq!(
        f.request("GET", false, Some(&f.owner)).await.1["status"],
        "unconfigured"
    );
    assert_eq!(
        f.request("POST", true, Some(&f.member)).await.1["status"],
        "unconfigured"
    );
    for expected in [None, Some(f.member.as_str())] {
        assert_eq!(f.request("POST", false, expected).await.0, 403);
    }
    assert_eq!(
        request(
            f.state.clone(),
            &uuid::Uuid::new_v4().to_string(),
            "GET",
            false,
            Some(&f.owner)
        )
        .await
        .0,
        403
    );
    f.state.close().await;
}
#[tokio::test]
async fn owner_and_member_explicit_checks_share_one_bounded_cache_and_get_never_fetches() {
    let (url, calls, task) = mock(
        200,
        release("v2.0.0").to_string(),
        Duration::from_millis(60),
    )
    .await;
    let f = Fixture::new(Some(url)).await;
    let prior = f.request("GET", false, Some(&f.owner)).await;
    assert_eq!(prior.1["reason"], "not_checked");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let (owner, member) = tokio::join!(
        f.request("POST", false, Some(&f.owner)),
        f.request("POST", true, Some(&f.member))
    );
    assert_eq!(owner.0, 200);
    assert_eq!(member.0, 200);
    assert_eq!(owner.1["scope"]["userId"], f.owner);
    assert_eq!(member.1["scope"]["userId"], f.member);
    assert_eq!(owner.1["status"], "update_available");
    assert_eq!(owner.1["serviceVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    f.state.updates.cache.lock().await.as_mut().unwrap().fetched =
        std::time::Instant::now() - Duration::from_secs(301);
    assert_eq!(f.request("GET", false, Some(&f.owner)).await.0, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.request("POST", false, Some(&f.owner)).await.0, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        f.request("GET", true, Some(&f.member)).await.1["release"]["tag"],
        "v2.0.0"
    );
    assert_eq!(f.request("POST", false, Some(&f.owner)).await.0, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    f.state.close().await;
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn a_previous_installation_uses_the_new_repository_for_updates() {
    let mut body = release("v2.0.0");
    let canonical_url = "https://github.com/zhiruiai/BambooShift/releases/tag/v2.0.0";
    body["html_url"] = canonical_url.into();
    let (url, calls, task) = mock(200, body.to_string(), Duration::ZERO).await;
    let f = Fixture::with_repository(Some(url), "ZhiruiAI/pandamate").await;

    let status = f.request("GET", false, Some(&f.owner)).await;
    assert_eq!(status.1["repository"], "zhiruiai/BambooShift");
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let checked = f.request("POST", false, Some(&f.owner)).await;
    assert_eq!(checked.0, 200);
    assert_eq!(checked.1["status"], "update_available");
    assert_eq!(checked.1["repository"], "zhiruiai/BambooShift");
    assert_eq!(checked.1["release"]["url"], canonical_url);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    f.state.close().await;
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn revocation_during_fetch_returns_no_result_and_does_not_publish_a_cache() {
    let (url, calls, task) = mock(
        200,
        release("v2.0.0").to_string(),
        Duration::from_millis(100),
    )
    .await;
    let f = Fixture::new(Some(url)).await;
    let state = f.state.clone();
    let owner = f.owner.clone();
    let wid = f.wid.clone();
    let pending =
        tokio::spawn(async move { request(state, &wid, "POST", false, Some(&owner)).await });
    entered(&calls).await;
    sqlx::query("DELETE FROM memberships WHERE user_id=? AND workspace_id=?")
        .bind(&f.owner)
        .bind(&f.wid)
        .execute(&f.state.pool)
        .await
        .unwrap();
    f.state
        .changed(Some(f.owner.clone()), Some(f.wid.clone()), None);
    assert_eq!(pending.await.unwrap().0, 403);
    assert_eq!(
        f.request("GET", true, Some(&f.member)).await.1["reason"],
        "not_checked"
    );
    f.state.close().await;
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn cancelled_check_drops_the_network_future_and_releases_the_concurrency_slot() {
    let (url, calls, task) = mock(
        200,
        release("v2.0.0").to_string(),
        Duration::from_millis(80),
    )
    .await;
    let f = Fixture::new(Some(url)).await;
    let state = f.state.clone();
    let owner = f.owner.clone();
    let wid = f.wid.clone();
    let pending =
        tokio::spawn(async move { request(state, &wid, "POST", false, Some(&owner)).await });
    entered(&calls).await;
    pending.abort();
    let _ = pending.await;
    assert_eq!(
        f.request("GET", false, Some(&f.owner)).await.1["reason"],
        "not_checked"
    );
    assert_eq!(f.request("POST", false, Some(&f.owner)).await.0, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    f.state.close().await;
    task.abort();
    let _ = task.await;
}
