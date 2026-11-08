#[path = "agent_computer_local/recovery.rs"]
mod recovery;

mod agent_computer_support;
mod agent_delegation_support;
mod computer_support;
mod workspace_support;
use agent_computer_support::*;
use openbot_backend::computer::{self, transport::Authority};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;

async fn local(group: &Group) {
    let (code, value) = group
        .f
        .request(
            "POST",
            &group.f.path("/computer/connect"),
            Some(json!({"mode":"local"})),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(code, 200, "{value}");
    assert_eq!(value["mode"], "local");
}

#[tokio::test]
async fn real_pi_local_bot_uses_explicit_approval_and_delegates_without_shared_surface_deadlock() {
    let group = Group::new().await;
    local(&group).await;
    let child = group.ids[1].clone();
    let counter = Arc::new(AtomicUsize::new(0));
    let steps = counter.clone();
    let model = Model::new(Arc::new(move |body| {
        let (child, steps) = (child.clone(), steps.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                if has_tool_result(&body) {
                    let value = tool_result(&body);
                    assert_eq!(value["status"], "done", "{value}");
                    finish("The delegated colleague read the same local workspace.")
                } else {
                    call("computer_action", json!({"type":"read_file","path":"local-approval.txt"}))
                }
            } else {
                match steps.fetch_add(1, Ordering::SeqCst) {
                    0 => call("computer_status", json!({})),
                    1 => {
                        let value = tool_result(&body);
                        assert_eq!(value["botScreen"]["shared"], true);
                        assert_eq!(value["botScreen"]["status"], "ready");
                        assert!(value["botScreen"]["screenId"].is_null());
                        assert!(value["targetRevision"].is_string());
                        call("computer_action", json!({"type":"write_file","path":"local-approval.txt","content":"local approved bytes"}))
                    }
                    2 => {
                        assert_eq!(tool_result(&body)["status"], "done");
                        call("delegate", json!({"agentId":child,"task":"Read local-approval.txt with computer_action and report its real result."}))
                    }
                    3 => finish("The approved local file and delegated read completed."),
                    _ => panic!("Unexpected local model call"),
                }
            }
        })
    })).await;
    configured(&group, &model, false).await;
    let input = group
        .send(
            "Create the approved local file then ask the colleague to check it.",
            "followUp",
            true,
        )
        .await;
    let action = pending(&group).await;
    let path = group.store.directory.join("workspace/local-approval.txt");
    assert!(!path.exists());
    assert!(action["screenBinding"].is_null());
    assert_eq!(approve(&group, &action, false).await.0, 403);
    assert_eq!(approve(&group, &action, true).await.0, 200);
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "done");
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "local approved bytes"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 4);
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["metadata"]["action"]["status"] == "done")
            .count(),
        2
    );
    assert_eq!(
        task_status(&group, &group.ids[1]).await["botScreen"]["task"]["status"],
        "idle"
    );
    assert_eq!(approve(&group, &action, true).await.0, 409);
    group.close().await;
}

#[tokio::test]
async fn stopped_local_pi_approval_cannot_replay_or_write() {
    let group = Group::new().await;
    local(&group).await;
    let model = Model::new(Arc::new(|body| Box::pin(async move {
        if has_tool_result(&body) { finish("Read the actual cancellation.") }
        else {call("computer_action", json!({"type":"write_file","path":"cancelled-local.txt","content":"must not appear"}))}
    }))).await;
    configured(&group, &model, false).await;
    let input = group
        .send("Request a local write then wait.", "followUp", false)
        .await;
    let action = pending(&group).await;
    group.stop().await;
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    assert!(
        !group
            .store
            .directory
            .join("workspace/cancelled-local.txt")
            .exists()
    );
    assert_eq!(approve(&group, &action, false).await.0, 409);
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "idle"
    );
    group.close().await;
}

fn authority(enabled: Arc<AtomicBool>) -> Authority {
    Arc::new(move || {
        let enabled = enabled.clone();
        Box::pin(async move {
            if enabled.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(openbot_backend::error::ApiError::new(
                    409,
                    "Synthetic cancellation",
                ))
            }
        })
    })
}
async fn until(check: impl AsyncFn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn separate_local_bot_roots_serialize_and_cancelled_waiter_does_not_block_following_work() {
    let group = Group::new().await;
    local(&group).await;
    let controller = group
        .f
        .state
        .computer
        .get(&group.f.state, group.store.clone())
        .await
        .unwrap();
    let allowed = authority(Arc::new(AtomicBool::new(true)));
    let first = computer::tasks::acquire(
        &controller,
        &group.ids[0],
        &group.cid,
        "synthetic-root-a",
        allowed.clone(),
    )
    .await
    .unwrap();
    let cancelled = Arc::new(AtomicBool::new(true));
    let (control, bot, chat, auth) = (
        controller.clone(),
        group.ids[1].clone(),
        group.cid.clone(),
        authority(cancelled.clone()),
    );
    let second = tokio::spawn(async move {
        computer::tasks::acquire(&control, &bot, &chat, "synthetic-root-b", auth).await
    });
    until(async || controller.tasks.state("default")["queued"] == 1).await;
    assert!(!second.is_finished());
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &group.f.path("/computer/disconnect"),
                Some(json!({})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        409
    );
    cancelled.store(false, Ordering::SeqCst);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), second)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert_eq!(controller.tasks.state("default")["queued"], 0);
    let (control, bot, chat, auth) = (
        controller.clone(),
        group.ids[2].clone(),
        group.cid.clone(),
        allowed.clone(),
    );
    let third = tokio::spawn(async move {
        computer::tasks::acquire(&control, &bot, &chat, "synthetic-root-c", auth).await
    });
    until(async || controller.tasks.state("default")["queued"] == 1).await;
    assert!(!third.is_finished());
    first.finish().await.unwrap();
    let third = tokio::time::timeout(Duration::from_secs(3), third)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(controller.tasks.state("default")["status"], "running");
    third.finish().await.unwrap();
    assert_eq!(controller.tasks.state("default")["status"], "idle");
    group.close().await;
}

/// The actual local launcher protocol fronts a synthetic HTTP Worker here, so
/// takeover and cleanup fences are exercised without opening any real browser.
async fn synthetic_local() -> (Group, Server, tempfile::TempDir) {
    let mut group = Group::new().await;
    let server = Server::start(&group.f.workspace).await;
    let runtime = tempfile::tempdir().unwrap();
    let worker = runtime.path().join("packages/computer-worker");
    std::fs::create_dir_all(&worker).unwrap();
    let source = format!(
        r#"import {{createInterface}} from 'node:readline';
const lines=createInterface({{input:process.stdin}});
lines.once('line',()=>{{process.stdout.write(JSON.stringify({{ready:true,url:{},token:{}}})+'\n');
lines.on('line',line=>{{if(line==='close')process.exit(0)}})}});
process.stdin.on('end',()=>process.exit(0));"#,
        serde_json::to_string(&server.worker.origin).unwrap(),
        serde_json::to_string(computer_support::TOKEN).unwrap()
    );
    std::fs::write(worker.join("index.mjs"), source).unwrap();
    group.f.state.close().await;
    let mut config = openbot_backend::config::Config::local(group.f.directory.path());
    config.runtime_dir = runtime.path().to_owned();
    group.f.state = openbot_backend::db::State::open(config).await.unwrap();
    group.store = group
        .f
        .state
        .workspace
        .get(&group.f.workspace, &group.f.workspace)
        .await
        .unwrap();
    local(&group).await;
    (group, server, runtime)
}

#[tokio::test]
async fn local_takeover_is_one_shared_lease_but_only_originating_bot_window_can_input_or_end() {
    let (group, server, _runtime) = synthetic_local().await;
    let before = server.worker.calls.lock().await.len();
    let (code, list) = group
        .f
        .request(
            "GET",
            &group.f.path("/computer/bots"),
            None,
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(code, 200, "{list}");
    assert_eq!(list["shared"], true);
    assert_eq!(list["capacity"]["max"], 1);
    assert!(list["bots"].as_array().unwrap().len() >= 4);
    assert_eq!(
        server.worker.calls.lock().await[before..]
            .iter()
            .filter(|(p, _)| p == "/health")
            .count(),
        1
    );
    let a = group.ids[0].clone();
    let b = group.ids[1].clone();
    let request =
        |agent: &str, route: &str| group.f.path(&format!("/computer/bots/{agent}/{route}"));
    let (code, action) = group
        .f
        .request(
            "POST",
            &request(&b, "actions"),
            Some(json!({"type":"browser_click","selector":"#synthetic"})),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(code, 200, "{action}");
    let (code, lease) = group
        .f
        .request(
            "POST",
            &request(&a, "takeover/start"),
            Some(json!({})),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(code, 200, "{lease}");
    assert_eq!(
        computer::action_store::get(&group.store, action["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "rejected"
    );
    let (_, status) = group
        .f
        .request(
            "GET",
            &request(&b, "takeover/status"),
            None,
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status["active"], true);
    assert!(status["leaseId"].is_null());
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &request(&b, "takeover/start"),
                Some(json!({})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        409
    );
    for route in ["takeover/input", "takeover/end"] {
        assert_eq!(
            group
                .f
                .request(
                    "POST",
                    &request(&b, route),
                    Some(json!({"leaseId":lease["leaseId"],"type":"key","key":"Enter"})),
                    false,
                    Some(&group.f.owner)
                )
                .await
                .0,
            409
        );
    }
    let controller = group
        .f
        .state
        .computer
        .get(&group.f.state, group.store.clone())
        .await
        .unwrap();
    assert!(
        computer::controls::screenshot(
            &controller,
            Some(&b),
            authority(Arc::new(AtomicBool::new(true))),
        )
        .await
        .is_err()
    );
    assert!(
        !server
            .worker
            .calls
            .lock()
            .await
            .iter()
            .any(|(p, _)| p == "/screenshot")
    );
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &request(&a, "takeover/input"),
                Some(json!({"leaseId":lease["leaseId"],"type":"key","key":"Enter"})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        200
    );
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &request(&a, "takeover/end"),
                Some(json!({"leaseId":lease["leaseId"]})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        200
    );
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &request(&a, "surface"),
                Some(json!({"surface":"desktop","confirm":true})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        403
    );
    assert!(
        server
            .worker
            .calls
            .lock()
            .await
            .iter()
            .all(|(p, _)| !p.starts_with("/screens"))
    );
    group.close().await;
}
