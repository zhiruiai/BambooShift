mod computer_support;
mod workspace_support;
use computer_support::*;
use openbot_backend::{computer, config::Config, db::State};
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use workspace_support::Fixture;

#[tokio::test]
async fn explicit_reconnect_keeps_assignments_and_does_not_clear_screen_cleanup_failure() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    let first = prepared(&f, agent).await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let controller = f.state.computer.get(&f.state, store).await.unwrap();
    controller
        .target(Arc::new(|| Box::pin(async { Ok(()) })))
        .await
        .unwrap()
        .poison();
    let (status, reply) = f
        .request(
            "POST",
            &f.path("/computer/reconnect"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let current = prepared(&f, agent).await;
    assert_eq!(
        current["botScreen"]["assignmentRevision"],
        first["botScreen"]["assignmentRevision"]
    );
    assert_eq!(current["desktop"]["session"], first["desktop"]["session"]);
    s.worker.cleanup_ok.store(false, Ordering::SeqCst);
    let endpoint = f.path(&format!("/computer/bots/{agent}/actions"));
    let (_, action) = f
        .request(
            "POST",
            &endpoint,
            Some(json!({"type":"terminal_command","command":"pwd"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(action["status"], "error");
    s.worker.cleanup_ok.store(true, Ordering::SeqCst);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/computer/reconnect"),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        f.request(
            "POST",
            &endpoint,
            Some(json!({"type":"terminal_command","command":"pwd"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    let (_, state) = f
        .request(
            "GET",
            &f.path(&format!("/computer/bots/{agent}/status")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(state["botScreen"]["task"]["status"], "blocked");
    assert_eq!(state["botScreen"]["lifecycle"]["resetAllowed"], true);
    f.state.close().await;
}

#[tokio::test]
async fn restart_rejects_old_approval_and_retains_unknown_cleanup_until_explicit_reset() {
    let mut f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    let before = prepared(&f, agent).await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let pending = uuid::Uuid::new_v4().to_string();
    let running = uuid::Uuid::new_v4().to_string();
    for (id, status) in [(&pending, "pending"), (&running, "running")] {
        computer::action_store::persist(&store, &json!({"id":id,"action":{"id":id,"type":"write_file","status":status,"createdAt":"2026-01-01T00:00:00Z"},"context":{"agentId":agent}})).await.unwrap();
    }
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    let base = f.path(&format!("/computer/bots/{agent}"));
    let (_, current) = f
        .request(
            "GET",
            &format!("{base}/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(
        current["botScreen"]["assignmentRevision"],
        before["botScreen"]["assignmentRevision"]
    );
    assert_eq!(current["botScreen"]["task"]["status"], "blocked");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    assert_eq!(
        computer::action_store::get(&store, &pending).await.unwrap()["status"],
        "rejected"
    );
    assert_eq!(
        computer::action_store::get(&store, &running).await.unwrap()["status"],
        "error"
    );
    assert_eq!(
        f.request(
            "POST",
            &format!("{base}/actions"),
            Some(json!({"type":"terminal_command","command":"pwd"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    let (status, reset) = f.request("POST", &format!("{base}/reset"), Some(json!({"confirm":true,"assignmentRevision":before["botScreen"]["assignmentRevision"]})), false, Some(&f.owner)).await;
    assert_eq!(status, 200, "{reset}");
    assert_eq!(reset["botScreen"]["task"]["status"], "idle");
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    let (_, reopened) = f
        .request(
            "GET",
            &format!("{base}/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(reopened["botScreen"]["task"]["status"], "idle");
    assert_eq!(
        f.request(
            "POST",
            &format!("{base}/actions"),
            Some(json!({"type":"terminal_command","command":"pwd"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    f.state.close().await;
}

#[test]
fn desktop_and_shell_validation_preserve_adapter_limits_and_plain_output() {
    for key in ["Control+c", "F12", "Shift+Tab", "Command+["] {
        computer::validation::validate_input(
            &json!({"type":"key","key":key}),
            1440,
            900,
            true,
            true,
        )
        .unwrap();
    }
    for input in [
        json!({"type":"key","key":"Control+ControlOrMeta+A"}),
        json!({"type":"type","text":""}),
        json!({"type":"scroll","deltaY":4001}),
        json!({"type":"drag","x":1,"y":1,"toX":2,"toY":2,"durationMs":2001}),
    ] {
        assert!(computer::validation::validate_input(&input, 1440, 900, true, true).is_err());
    }
    let good = json!({"stdout":"<script>plain</script>","stderr":"","exitCode":null,"signal":"SIGKILL","truncated":false,"cancelled":false,"timedOut":false,"durationMs":30,"resourceLimit":"pids"});
    computer::validation::shell_result(&good).unwrap();
    let mut bad = good.clone();
    bad["stdout"] = json!("x".repeat(256 * 1024 + 1));
    assert!(computer::validation::shell_result(&bad).is_err());
    let mut bad = good;
    bad["exitCode"] = json!(256);
    assert!(computer::validation::shell_result(&bad).is_err());
}

#[tokio::test]
async fn explicit_reconnect_does_not_accept_control_origin_drift() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    *s.worker.control_origin.lock().await = json!("https://other.example.test");
    let (status, _) = f
        .request(
            "POST",
            &f.path("/computer/reconnect"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    assert!(
        computer::private_config::read(&store.directory)
            .unwrap()
            .unwrap()
            .remote
            .unwrap()
            .control_origin
            .is_none()
    );
    f.state.close().await;
}
