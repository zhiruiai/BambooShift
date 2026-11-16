#![cfg(target_os = "macos")]
mod agent_delegation_support;
mod common;
mod workspace_support;
use agent_delegation_support::{Model, call, finish};
use common::{Reply, request};
use openbot_backend::{
    config::{Config, LocalDesktopConfig},
    db::State,
    product_router,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

struct Session {
    app: axum::Router,
    prefix: String,
    cookie: String,
    user: String,
}
impl Session {
    async fn request(&self, method: &str, tail: &str, body: Option<Value>) -> Reply {
        request(
            &self.app,
            method,
            &format!("{}{tail}", self.prefix),
            &self.cookie,
            body,
            &[("x-openbot-expected-user", &self.user)],
        )
        .await
    }
    async fn actions(&self) -> Vec<Value> {
        let reply = self.request("GET", "/computer/actions", None).await;
        assert_eq!(reply.status, 200, "{}", reply.value);
        reply.value.as_array().unwrap().clone()
    }
    async fn wait_action(&self, command: &str, status: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(35), async {
            loop {
                if let Some(action) = self
                    .actions()
                    .await
                    .into_iter()
                    .find(|a| a["payload"]["command"] == command && a["status"] == status)
                {
                    return action;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("App launch did not reach expected audit state")
    }
    async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(35), async {
            loop {
                let boot = self.request("GET", "/bootstrap", None).await;
                if boot.value["runningRequests"]
                    .as_array()
                    .is_some_and(|v| v.is_empty())
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("Agent launch turn did not finish")
    }
    async fn mode(&self, mode: &str) {
        let status = self.request("GET", "/computer/status", None).await;
        let result = self
            .request(
                "POST",
                "/computer/authorization",
                Some(json!({
            "mode":mode,"expectedTargetRevision":status.value["targetRevision"]})),
            )
            .await;
        assert_eq!(result.status, 200, "{}", result.value);
    }
}

#[tokio::test]
async fn agent_app_launch_uses_audited_shell_without_ax_and_preserves_approval_and_revocation() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = Config::local(directory.path());
    config.local_desktop = Some(LocalDesktopConfig {
        bootstrap_token: "a".repeat(64),
        host_control: true,
        desktop_driver: None,
        accessibility_helper: None,
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
    assert_eq!(opened.status, 200);
    let wid = opened.value["workspaceId"].as_str().unwrap();
    let session = Session {
        app,
        prefix: format!("/api/workspaces/{wid}"),
        cookie: opened.cookie(),
        user: opened.value["user"]["id"].as_str().unwrap().into(),
    };
    let boot = session.request("GET", "/bootstrap", None).await;
    let bot = boot.value["agents"][0]["id"].as_str().unwrap();
    let chat = boot.value["conversations"][0]["id"].as_str().unwrap();
    let connected = session
        .request("POST", "/computer/connect", Some(json!({"mode":"local"})))
        .await;
    assert_eq!(connected.status, 200, "{}", connected.value);
    assert_eq!(connected.value["surface"], "browser");
    assert_ne!(connected.value["desktop"]["accessibilityReady"], true);

    // Uninstalled, unique bundle IDs exercise the real OS command's failure
    // receipt without launching or interacting with any installed user app.
    for (index, mode) in ["confirm", "full", "confirm"].into_iter().enumerate() {
        session.mode(mode).await;
        let bundle = format!("test.bambooshift.Missing-{}", uuid::Uuid::new_v4());
        let command = format!("/usr/bin/open -b '{bundle}'");
        let model = Model::new(Arc::new(move |body| {
            let bundle = bundle.clone();
            Box::pin(async move {
                let done = body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .take_while(|m| m["role"] != "user")
                    .any(|m| m["role"] == "tool");
                if done {
                    finish("Exact launch receipt recorded.")
                } else {
                    call("computer_open_mac_app", json!({"bundleId":bundle}))
                }
            })
        }))
        .await;
        assert_eq!(
            session
                .request("PUT", "/settings", Some(model.config()))
                .await
                .status,
            200
        );
        let sent = session
            .request(
                "POST",
                &format!("/conversations/{chat}/messages"),
                Some(json!({
            "agentId":bot,"content":format!("Launch synthetic missing app {index}"),
            "mode":"followUp","clientId":uuid::Uuid::new_v4().to_string()})),
            )
            .await;
        assert_eq!(sent.status, 202, "{}", sent.value);
        let action = session
            .wait_action(&command, if mode == "full" { "done" } else { "pending" })
            .await;
        assert_eq!(action["type"], "local_shell");
        assert_eq!(action["payload"]["path"], ".");
        if mode == "full" {
            assert_eq!(action["authorization"]["mode"], "full");
            assert!(
                action["result"]["exitCode"]
                    .as_i64()
                    .is_some_and(|code| code != 0),
                "Missing app must return an actual failing exit code: {action}"
            );
            assert_eq!(action["result"]["timedOut"], false);
        } else {
            assert!(
                action.get("result").is_none(),
                "No command executes before approval"
            );
            let id = action["id"].as_str().unwrap();
            let rejected = session
                .request(
                    "POST",
                    &format!("/computer/actions/{id}/reject"),
                    Some(json!({})),
                )
                .await;
            assert_eq!(rejected.status, 200, "{}", rejected.value);
        }
        session.idle().await;
        let status = session.request("GET", "/computer/status", None).await;
        assert_eq!(
            status.value["surface"], "browser",
            "Opening apps never changes the selected surface"
        );
        assert_eq!(status.value["authorization"]["mode"], mode);
    }
    assert_eq!(session.actions().await.len(), 3);
    state.close().await;
}
