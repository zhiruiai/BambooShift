mod common;
use common::request;
use openbot_backend::{
    config::{Config, LocalDesktopConfig},
    db::State,
    product_router,
};
use serde_json::json;

#[tokio::test]
async fn personal_commands_require_host_opt_in_and_explicit_approval() {
    for enabled in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let mut config = Config::local(directory.path());
        config.local_desktop = Some(LocalDesktopConfig {
            bootstrap_token: "a".repeat(64),
            host_control: enabled,
            desktop_driver: None,
        });
        let state = State::open(config).await.unwrap();
        let app = product_router(state.clone());
        let opened = request(
            &app,
            "POST",
            "/api/account/local-session",
            "",
            Some(json!({})),
            &[("x-bambooshift-local-token", &"a".repeat(64))],
        )
        .await;
        assert_eq!(opened.status, 200, "{}", opened.value);
        let workspace = opened.value["workspaceId"].as_str().unwrap();
        let cookie = opened.cookie();
        let headers = [(
            "x-openbot-expected-user",
            opened.value["user"]["id"].as_str().unwrap(),
        )];
        let prefix = format!("/api/workspaces/{workspace}/computer");
        let connected = request(
            &app,
            "POST",
            &format!("{prefix}/connect"),
            &cookie,
            Some(json!({"mode":"local"})),
            &headers,
        )
        .await;
        assert_eq!(connected.status, 200, "{}", connected.value);
        assert_eq!(
            connected.value["capabilities"]
                .as_array()
                .unwrap()
                .contains(&json!("local-shell-v1")),
            enabled
        );
        let actions = format!("{prefix}/actions");
        let pending = request(
            &app,
            "POST",
            &actions,
            &cookie,
            Some(json!({"type":"local_shell","command":"printf approved"})),
            &headers,
        )
        .await;
        if !enabled {
            assert_eq!(pending.status, 409, "{}", pending.value);
        } else {
            assert_eq!(pending.status, 200, "{}", pending.value);
            assert_eq!(pending.value["status"], "pending");
            assert!(pending.value.get("result").is_none());
            let id = pending.value["id"].as_str().unwrap();
            let approved = request(
                &app,
                "POST",
                &format!("{actions}/{id}/approve"),
                &cookie,
                Some(json!({})),
                &headers,
            )
            .await;
            assert_eq!(approved.status, 200, "{}", approved.value);
            let mut done = false;
            for _ in 0..100 {
                let listing = request(&app, "GET", &actions, &cookie, None, &headers).await;
                let action = listing
                    .value
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|a| a["id"] == id)
                    .unwrap();
                if action["status"] == "done" {
                    assert_eq!(action["result"]["stdout"], "approved");
                    assert_eq!(action["result"]["exitCode"], 0);
                    done = true;
                    break;
                }
                assert_ne!(action["status"], "error", "{action}");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            assert!(done, "Approved local command did not settle");
        }
        state.close().await;
    }
}
