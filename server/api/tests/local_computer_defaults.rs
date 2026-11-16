#![cfg(target_os = "macos")]
mod common;
use common::{Reply, request};
use openbot_backend::{
    config::{Config, LocalDesktopConfig},
    db::State,
    product_router,
};
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::PathBuf};

struct Fixture {
    directory: tempfile::TempDir,
    config: Config,
    state: State,
    cookie: String,
    workspace: String,
    user: String,
    permission: PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("synthetic-helper");
        let permission = directory.path().join("permission-revoked");
        let events = directory.path().join("native-events");
        // This helper never calls native OS APIs. Screen recording stays denied
        // for the whole test; unexpected screenshots or inputs fail the request.
        std::fs::write(&helper, format!(r##"#!/usr/bin/python3
import json, os, sys
p = json.load(sys.stdin)
if p['op'] == 'status':
    ready = not os.path.exists({permission})
    result = {{'available': False, 'width': 0, 'height': 0, 'displays': [],
      'accessibilityAvailable': True, 'accessibilityReady': ready, 'appLaunchAvailable': True,
      'permissions': {{'screenRecording': 'denied', 'accessibility': 'granted' if ready else 'denied'}}}}
elif p['op'] == 'ax_open_target':
    assert p['enabled'] and p['app'] == 'com.google.Chrome'
    result = {{'app': {{'bundleId': p['app'], 'name': 'Synthetic Chrome'}}, 'identity': 'a' * 64}}
elif p['op'] == 'ax_open':
    assert p['enabled'] and p['app'] == 'com.google.Chrome' and p['appIdentity'] == 'a' * 64
    with open({events}, 'a') as f: f.write(p['app'] + '\n')
    result = {{'ok': True}}
else:
    raise AssertionError('Unexpected native operation')
json.dump({{'ok': True, 'result': result}}, sys.stdout)
"##, permission = json!(permission), events = json!(events))).unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = Config::local(directory.path());
        config.local_desktop = Some(LocalDesktopConfig {
            bootstrap_token: "a".repeat(64),
            host_control: true,
            desktop_driver: None,
            accessibility_helper: Some(helper),
        });
        let state = State::open(config.clone()).await.unwrap();
        let opened = request(
            &product_router(state.clone()),
            "POST",
            "/api/account/local-session",
            "",
            Some(json!({})),
            &[("x-bambooshift-local-token", &"a".repeat(64))],
        )
        .await;
        assert_eq!(opened.status, 200, "{}", opened.value);
        Self {
            directory,
            config,
            state,
            cookie: opened.cookie(),
            workspace: opened.value["workspaceId"].as_str().unwrap().into(),
            user: opened.value["user"]["id"].as_str().unwrap().into(),
            permission,
        }
    }
    async fn call(&self, tail: &str, body: Option<Value>) -> Reply {
        request(
            &product_router(self.state.clone()),
            if body.is_some() { "POST" } else { "GET" },
            &format!("/api/workspaces/{}/computer{tail}", self.workspace),
            &self.cookie,
            body,
            &[("x-openbot-expected-user", &self.user)],
        )
        .await
    }
    async fn ok(&self, tail: &str, body: Option<Value>) -> Value {
        let reply = self.call(tail, body).await;
        assert_eq!(reply.status, 200, "{tail}: {}", reply.value);
        reply.value
    }
    async fn status(&self, surface: &str, mode: &str) -> Value {
        let value = self.ok("/status", None).await;
        assert_eq!(value["surface"], surface, "{value}");
        assert_eq!(value["authorization"]["mode"], mode, "{value}");
        value
    }
    async fn grant(&self, mode: &str) {
        let status = self.ok("/status", None).await;
        self.ok(
            "/authorization",
            Some(json!({"mode":mode,"expectedTargetRevision":status["targetRevision"]})),
        )
        .await;
    }
    async fn restart(&mut self) {
        self.state.close().await;
        self.state = State::open(self.config.clone()).await.unwrap();
    }
}

#[tokio::test]
async fn local_defaults_survive_restart_and_obey_browser_choice_revocation_and_os_permissions() {
    let mut f = Fixture::new().await;
    f.status("browser", "confirm").await;
    f.grant("full").await;
    f.restart().await;
    let restored = f.status("accessibility", "full").await;
    assert_ne!(
        restored["desktop"]["authorized"], true,
        "No screen recording permission"
    );
    let boot = request(
        &product_router(f.state.clone()),
        "GET",
        &format!("/api/workspaces/{}/bootstrap", f.workspace),
        &f.cookie,
        None,
        &[],
    )
    .await;
    assert_eq!(boot.status, 200);
    let bot = boot.value["agents"][0]["id"].as_str().unwrap();
    let bot_status = f.ok(&format!("/bots/{bot}/status"), None).await;
    assert_eq!(bot_status["surface"], "accessibility");
    assert_eq!(bot_status["authorization"]["mode"], "full");
    assert_eq!(bot_status["targetRevision"], restored["targetRevision"]);
    let opened = f
        .ok(
            &format!("/bots/{bot}/actions"),
            Some(json!({"type":"desktop_ax_open","bundleId":"com.google.Chrome"})),
        )
        .await;
    assert_eq!(opened["status"], "done", "{opened}");
    assert_eq!(opened["authorization"]["mode"], "full");
    assert_eq!(
        std::fs::read_to_string(f.directory.path().join("native-events")).unwrap(),
        "com.google.Chrome\n"
    );

    // Both the app and Bot view write the same preference; an explicit browser
    // selection is durable and must never be overwritten by the legacy migration.
    f.ok(
        &format!("/bots/{bot}/surface"),
        Some(json!({"surface":"browser"})),
    )
    .await;
    f.restart().await;
    f.status("browser", "full").await;
    f.ok(
        "/surface",
        Some(json!({"surface":"accessibility","confirm":true})),
    )
    .await;
    f.restart().await;
    f.status("accessibility", "full").await;
    f.grant("confirm").await;
    f.restart().await;
    f.status("browser", "confirm").await;
    f.grant("full").await;
    f.restart().await;
    f.status("accessibility", "full").await;

    std::fs::write(&f.permission, "denied").unwrap();
    f.restart().await;
    let denied = f.status("browser", "full").await;
    assert_ne!(denied["desktop"]["accessibilityReady"], true);
    let blocked = f
        .call(
            "/actions",
            Some(json!({"type":"desktop_ax_open","bundleId":"com.google.Chrome"})),
        )
        .await;
    assert_ne!(blocked.status, 200);
    std::fs::remove_file(&f.permission).unwrap();
    f.restart().await;
    f.status("accessibility", "full").await;
    f.config.local_desktop.as_mut().unwrap().host_control = false;
    f.restart().await;
    f.status("browser", "full").await;

    // A copied preference cannot restore native control under a grant bound to
    // another hardware identity, even if native permissions are available.
    f.state.close().await;
    let journal = f.directory.path().join(format!(
        "spaces/{}/computer/authorization.json",
        f.workspace
    ));
    let mut grants: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    grants["grants"][0]["target"] = json!("0".repeat(64));
    std::fs::write(&journal, serde_json::to_vec(&grants).unwrap()).unwrap();
    f.config.local_desktop.as_mut().unwrap().host_control = true;
    f.state = State::open(f.config.clone()).await.unwrap();
    f.status("browser", "confirm").await;
    f.state.close().await;
}
