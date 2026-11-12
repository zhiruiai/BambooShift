mod common;
use common::{Fixture, request};
use openbot_backend::{
    config::{Config, LocalDesktopConfig},
    db::State,
    product_router,
};
use serde_json::json;
use tempfile::TempDir;

fn configured(path: &std::path::Path, token: char) -> Config {
    let mut config = Config::local(path);
    config.local_desktop = Some(LocalDesktopConfig {
        bootstrap_token: token.to_string().repeat(64),
        host_control: false,
        desktop_driver: None,
    });
    config
}

#[tokio::test]
async fn local_profile_requires_private_startup_proof_and_keeps_normal_authorization() {
    let directory = TempDir::new().unwrap();
    let state = State::open(configured(directory.path(), 'a'))
        .await
        .unwrap();
    let app = product_router(state.clone());
    for headers in [vec![], vec![("x-bambooshift-local-token", "incorrect")]] {
        assert_eq!(
            request(
                &app,
                "POST",
                "/api/account/local-session",
                "",
                Some(json!({})),
                &headers
            )
            .await
            .status,
            403
        );
    }
    let token = "a".repeat(64);
    let headers = [("x-bambooshift-local-token", token.as_str())];
    let opened = request(
        &app,
        "POST",
        "/api/account/local-session",
        "",
        Some(json!({})),
        &headers,
    )
    .await;
    assert_eq!(opened.status, 200, "{}", opened.value);
    assert_eq!(opened.value["user"]["localOnly"], true);
    assert_eq!(opened.value["user"]["email"], "");
    assert_eq!(opened.value["workspaces"].as_array().unwrap().len(), 1);
    assert!(!opened.value.to_string().contains(&token));
    assert!(!opened.value.to_string().contains("password"));
    let cookie = opened.cookie();
    let workspace = opened.value["workspaceId"].as_str().unwrap();
    let user = opened.value["user"]["id"].as_str().unwrap();
    let bootstrap = format!("/api/workspaces/{workspace}/bootstrap");
    assert_eq!(
        request(&app, "GET", &bootstrap, "", None, &[]).await.status,
        401
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &bootstrap,
            &cookie,
            None,
            &[("x-openbot-expected-user", "wrong")]
        )
        .await
        .status,
        403
    );
    assert_eq!(
        request(&app, "GET", &bootstrap, &cookie, None, &[])
            .await
            .status,
        200
    );
    let model = request(&app, "PUT", &format!("/api/workspaces/{workspace}/settings"), &cookie,
        Some(json!({"provider":"synthetic","model":"fixture","baseUrl":"https://model.example.test/v1","apiKey":"SYNTHETIC_LOCAL_KEY"})),
        &[("x-openbot-expected-user", user)]).await;
    assert_eq!(model.status, 200, "{}", model.value);
    assert!(!model.value.to_string().contains("SYNTHETIC_LOCAL_KEY"));
    for path in ["/api/account/register", "/api/account/login"] {
        assert_eq!(
            request(&app, "POST", path, "", Some(json!({})), &[])
                .await
                .status,
            403
        );
    }
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/account/local-session",
            "",
            Some(json!({"userId":"another-user"})),
            &headers
        )
        .await
        .status,
        400
    );
    let cross_origin = [
        ("x-bambooshift-local-token", token.as_str()),
        ("origin", "https://unrelated.example.test"),
    ];
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/account/local-session",
            "",
            Some(json!({})),
            &cross_origin
        )
        .await
        .status,
        403
    );
    state.close().await;
}

#[tokio::test]
async fn restart_rotates_bootstrap_proof_without_replacing_the_workspace_or_model() {
    let directory = TempDir::new().unwrap();
    let state = State::open(configured(directory.path(), 'a'))
        .await
        .unwrap();
    let app = product_router(state.clone());
    let first = request(
        &app,
        "POST",
        "/api/account/local-session",
        "",
        Some(json!({})),
        &[("x-bambooshift-local-token", &"a".repeat(64))],
    )
    .await;
    assert_eq!(first.status, 200);
    let workspace = first.value["workspaceId"].as_str().unwrap();
    let settings = format!("/api/workspaces/{workspace}/settings");
    assert_eq!(request(&app, "PUT", &settings, &first.cookie(), Some(json!({"provider":"synthetic","model":"fixture","baseUrl":"https://model.example.test/v1","apiKey":"SYNTHETIC_LOCAL_KEY"})), &[("x-openbot-expected-user", first.value["user"]["id"].as_str().unwrap())]).await.status, 200);
    state.close().await;
    let state = State::open(configured(directory.path(), 'b'))
        .await
        .unwrap();
    let app = product_router(state.clone());
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/account/local-session",
            "",
            Some(json!({})),
            &[("x-bambooshift-local-token", &"a".repeat(64))]
        )
        .await
        .status,
        403
    );
    let reopened = request(
        &app,
        "POST",
        "/api/account/local-session",
        &first.cookie(),
        Some(json!({})),
        &[("x-bambooshift-local-token", &"b".repeat(64))],
    )
    .await;
    assert_eq!(reopened.status, 200);
    assert_eq!(reopened.value["user"]["id"], first.value["user"]["id"]);
    assert_eq!(reopened.value["workspaceId"], first.value["workspaceId"]);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/workspaces/{workspace}/bootstrap"),
            &reopened.cookie(),
            None,
            &[]
        )
        .await
        .value["settings"]["model"],
        "fixture"
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/account/session",
            &first.cookie(),
            None,
            &[]
        )
        .await
        .value["authenticated"],
        false
    );
    state.close().await;
}

#[tokio::test]
async fn local_mode_never_adopts_an_existing_hosted_account() {
    let fixture = Fixture::new().await;
    fixture.register("owner@example.test", false).await;
    assert_eq!(
        fixture
            .request("POST", "/api/account/local-session", "", Some(json!({})))
            .await
            .status,
        404
    );
    fixture.state.close().await;
    let state = State::open(configured(fixture.directory.path(), 'a'))
        .await
        .unwrap();
    let app = product_router(state.clone());
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/account/local-session",
            "",
            Some(json!({})),
            &[("x-bambooshift-local-token", &"a".repeat(64))]
        )
        .await
        .status,
        409
    );
    state.close().await;
}

#[test]
fn passwordless_runtime_cannot_be_configured_as_a_hosted_or_operator_server() {
    let directory = TempDir::new().unwrap();
    let mut config = configured(directory.path(), 'a');
    assert!(config.validate().is_ok());
    config.public_origin = Some("https://workspace.example.test".into());
    assert!(config.validate().is_err());
    config.public_origin = None;
    config.web_origin = Some("https://workspace.example.test".into());
    assert!(config.validate().is_err());
    config.web_origin = None;
    config.local_desktop.as_mut().unwrap().bootstrap_token = "short".into();
    assert!(config.validate().is_err());
}
