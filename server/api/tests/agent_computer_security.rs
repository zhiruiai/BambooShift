mod agent_computer_support;
mod agent_delegation_support;
mod computer_support;
mod workspace_support;
use agent_computer_support::*;
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};

async fn action_model(group: &Group) -> Model {
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            if has_tool_result(&body) {
                finish("The model finished after reading the actual tool result.")
            } else {
                call(
                    "computer_action",
                    json!({"type":"browser_click","selector":"#synthetic-save"}),
                )
            }
        })
    }))
    .await;
    configured(group, &model, false).await;
    model
}

#[tokio::test]
async fn only_requester_can_stop_and_pending_action_never_executes_after_stop() {
    let group = Group::new().await;
    let server = connected(&group).await;
    let _model = action_model(&group).await;
    let input = group
        .send(
            "Request a computer action and wait for approval.",
            "followUp",
            true,
        )
        .await;
    let action = pending(&group).await;
    let endpoint = group.f.path(&format!("/conversations/{}/stop", group.cid));
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &endpoint,
                Some(json!({})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        403
    );
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &endpoint,
                Some(json!({})),
                true,
                Some(&group.f.member)
            )
            .await
            .0,
        200
    );
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    assert_eq!(executions(&server.worker).await, 0);
    assert_eq!(approve(&group, &action, true).await.0, 409);
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "idle"
    );
    group.close().await;
}

#[tokio::test]
async fn original_session_revocation_cancels_the_real_waiting_approval_and_releases_task() {
    let group = Group::new().await;
    let server = connected(&group).await;
    let _model = action_model(&group).await;
    let input = group
        .send(
            "Wait for this original member's approval.",
            "followUp",
            true,
        )
        .await;
    let action = pending(&group).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&group.f.member)
        .execute(&group.f.db)
        .await
        .unwrap();
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    assert_eq!(executions(&server.worker).await, 0);
    let card = messages
        .iter()
        .find(|m| m["metadata"]["action"]["id"] == action["id"])
        .unwrap();
    assert_eq!(card["metadata"]["action"]["status"], "rejected");
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "idle"
    );
    group.close().await;
}

#[tokio::test]
async fn unconfirmed_cleanup_overrides_model_success_and_blocks_later_root_dispatch() {
    let group = Group::new().await;
    let server = connected(&group).await;
    let _model = action_model(&group).await;
    server.worker.cleanup_ok.store(false, Ordering::SeqCst);
    let input = group
        .send("Run the synthetic operation.", "followUp", false)
        .await;
    let action = pending(&group).await;
    assert_eq!(approve(&group, &action, false).await.0, 200);
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    let count = executions(&server.worker).await;
    assert_eq!(count, 1);
    let status = task_status(&group, &group.ids[0]).await;
    assert_eq!(status["botScreen"]["task"]["status"], "blocked");
    assert_eq!(status["botScreen"]["lifecycle"]["resetAllowed"], true);
    server.worker.cleanup_ok.store(true, Ordering::SeqCst);
    group
        .send(
            "Try again without an explicit maintenance reset.",
            "followUp",
            false,
        )
        .await;
    group.done().await;
    assert_eq!(executions(&server.worker).await, count);
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "blocked"
    );
    group.close().await;
}

#[tokio::test]
async fn computer_without_confirmed_cleanup_capability_never_gets_a_mutating_approval() {
    let group = Group::new().await;
    let server = connected(&group).await;
    server.worker.cleanup_capable.store(false, Ordering::SeqCst);
    let model=Model::new(Arc::new(|body|Box::pin(async move {
        assert!(!body["tools"].as_array().unwrap().iter().any(|t|t["function"]["name"]=="computer_observe"));
        if has_tool_result(&body) {
            assert!(body.to_string().contains("升级执行器"));
            finish("This computer does not support confirmed cleanup, so no action was dispatched.")
        } else {call("computer_action",json!({"type":"write_file","path":"unavailable.txt","content":"must not execute"}))}
    }))).await;
    configured(&group, &model, false).await;
    group
        .send(
            "Try the incompatible computer and report its actual error.",
            "followUp",
            false,
        )
        .await;
    let messages = group.done().await;
    assert!(
        messages
            .iter()
            .all(|m| m["metadata"].get("action").is_none())
    );
    assert_eq!(executions(&server.worker).await, 0);
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "idle"
    );
    group.close().await;
}

#[tokio::test]
async fn stopping_a_dispatched_action_keeps_root_and_task_until_worker_cleanup_acknowledges() {
    let group = Group::new().await;
    let server = connected(&group).await;
    let _model = action_model(&group).await;
    let execute_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let cleanup_gate = Arc::new(tokio::sync::Semaphore::new(0));
    *server.worker.execute_gate.lock().await = Some(execute_gate.clone());
    *server.worker.cleanup_gate.lock().await = Some(cleanup_gate.clone());
    let input = group
        .send(
            "Execute, then stop before the operation returns.",
            "followUp",
            true,
        )
        .await;
    let action = pending(&group).await;
    assert_eq!(approve(&group, &action, true).await.0, 200);
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while executions(&server.worker).await == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let endpoint = group.f.path(&format!("/conversations/{}/stop", group.cid));
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &endpoint,
                Some(json!({})),
                true,
                Some(&group.f.member)
            )
            .await
            .0,
        200
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !server
            .worker
            .calls
            .lock()
            .await
            .iter()
            .any(|(path, _)| path.ends_with("/operations/cancel"))
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let controller = group
        .f
        .state
        .computer
        .get(&group.f.state, group.store.clone())
        .await
        .unwrap();
    let state = controller.tasks.state(&group.ids[0]);
    assert!(
        matches!(
            state["status"].as_str(),
            Some("running" | "waiting_cleanup")
        ),
        "{state}"
    );
    assert!(
        group
            .f
            .state
            .agent_runs
            .requests(&group.f.workspace)
            .await
            .iter()
            .any(|r| r["conversationId"] == group.cid)
    );
    cleanup_gate.add_permits(1);
    execute_gate.add_permits(1);
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "idle"
    );
    assert_eq!(executions(&server.worker).await, 1);
    group.close().await;
}

#[tokio::test]
async fn observe_cleanup_failure_without_action_card_cannot_finish_successfully_and_survives_restart()
 {
    let group = Group::new().await;
    let server = connected(&group).await;
    server.worker.cleanup_ok.store(false, Ordering::SeqCst);
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            if has_tool_result(&body) {
                finish("The model returned text after its failed observation.")
            } else {
                call("computer_observe", json!({}))
            }
        })
    }))
    .await;
    configured(&group, &model, true).await;
    let input = group
        .send("Observe the selected computer.", "followUp", false)
        .await;
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    assert!(
        messages
            .iter()
            .all(|m| m["metadata"].get("action").is_none())
    );
    let controller = group
        .f
        .state
        .computer
        .get(&group.f.state, group.store.clone())
        .await
        .unwrap();
    assert_eq!(controller.tasks.state(&group.ids[0])["status"], "blocked");
    let fresh = openbot_backend::computer::controller::ComputerRuntime::default();
    let restored = fresh
        .get(&group.f.state, group.store.clone())
        .await
        .unwrap();
    assert_eq!(restored.tasks.state(&group.ids[0])["status"], "blocked");
    fresh.close().await;
    group.close().await;
}
