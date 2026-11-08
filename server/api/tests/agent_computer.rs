mod agent_computer_support;
mod agent_delegation_support;
mod computer_support;
mod workspace_support;
use agent_computer_support::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn real_pi_computer_tools_use_requester_approval_real_frames_and_a_root_lifetime_lease() {
    let group = Group::new().await;
    let server = connected(&group).await;
    let state_references = Arc::strong_count(&group.f.state.computer);
    let steps = Arc::new(AtomicUsize::new(0));
    let reached = Arc::new(Semaphore::new(0));
    let finish_gate = Arc::new(Semaphore::new(0));
    let (counter, arrived, gate) = (steps.clone(), reached.clone(), finish_gate.clone());
    let png = STANDARD.encode(&server.worker.png);
    let model = Model::new(Arc::new(move |body| {
        let (counter, arrived, gate, png) =
            (counter.clone(), arrived.clone(), gate.clone(), png.clone());
        Box::pin(async move {
            assert!(
                body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["function"]["name"] == "computer_observe")
            );
            match counter.fetch_add(1, Ordering::SeqCst) {
                0 => call("computer_status", json!({})),
                1 => {
                    assert_eq!(tool_result(&body)["botScreen"]["status"], "unassigned");
                    call(
                        "computer_action",
                        json!({"type":"browser_click","selector":"#synthetic-save"}),
                    )
                }
                2 => {
                    let action = tool_result(&body);
                    assert_eq!(action["status"], "done");
                    assert_eq!(action["frame"]["mimeType"], "image/webp");
                    call("computer_result", json!({"id":action["id"]}))
                }
                3 => {
                    assert_eq!(tool_result(&body)["status"], "done");
                    call("computer_observe", json!({}))
                }
                4 => {
                    assert!(body.to_string().contains(&png));
                    arrived.add_permits(1);
                    gate.acquire().await.unwrap().forget();
                    finish("The approved operation and actual computer image were verified.")
                }
                _ => panic!("Unexpected computer model request"),
            }
        })
    }))
    .await;
    configured(&group, &model, true).await;
    let input = group
        .send("Perform the synthetic computer task.", "followUp", true)
        .await;
    let action = pending(&group).await;
    assert_eq!(action["requester"]["userId"], group.f.member);
    assert_eq!(action["requester"]["messageId"], input["id"]);
    assert_eq!(executions(&server.worker).await, 0);
    assert_eq!(approve(&group, &action, false).await.0, 403);
    let approved = approve(&group, &action, true).await;
    assert_eq!(approved.0, 200, "{}", approved.1);
    wait_gate(&reached).await;
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "running"
    );
    finish_gate.add_permits(1);
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "done");
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["task"]["status"],
        "idle"
    );
    assert_eq!(executions(&server.worker).await, 1);
    let card = messages
        .iter()
        .find(|m| m["metadata"]["action"]["id"] == action["id"])
        .unwrap();
    assert_eq!(card["metadata"]["action"]["status"], "done");
    assert!(card["metadata"]["action"]["frame"]["id"].is_string());
    assert!(
        !card
            .to_string()
            .contains(&STANDARD.encode(&server.worker.png))
    );
    assert_eq!(steps.load(Ordering::SeqCst), 5);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while Arc::strong_count(&group.f.state.computer) > state_references {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Completed computer jobs retained their original State and task family");
    assert_eq!(
        openbot_backend::computer::action_store::get(&group.store, action["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "done"
    );

    group.close().await;
}

#[tokio::test]
async fn repeated_child_reuses_its_root_owned_lease_after_previous_child_finishes() {
    let group = Group::new().await;
    let server = connected(&group).await;
    let child = group.ids[1].clone();
    let count = Arc::new(AtomicUsize::new(0));
    let steps = count.clone();
    let model = Model::new(Arc::new(move |body| {
        let (child, steps) = (child.clone(), steps.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                if has_tool_result(&body) {
                    assert_eq!(tool_result(&body)["status"], "done");
                    finish("Child checked its own assigned computer.")
                } else {
                    call(
                        "computer_action",
                        json!({"type":"terminal_command","command":"pwd"}),
                    )
                }
            } else if steps.fetch_add(1, Ordering::SeqCst) < 2 {
                call(
                    "delegate",
                    json!({"agentId":child,"task":"Read your own computer working directory."}),
                )
            } else {
                finish("Both child computer checks completed using the same assigned screen.")
            }
        })
    }))
    .await;
    configured(&group, &model, false).await;
    let input = group
        .send("Ask the same colleague twice.", "followUp", false)
        .await;
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "done");
    let actions = messages
        .iter()
        .filter(|m| m["metadata"]["action"].is_object())
        .collect::<Vec<_>>();
    assert_eq!(actions.len(), 2);
    assert!(
        actions
            .iter()
            .all(|m| m["metadata"]["action"]["status"] == "done"
                && m["agentId"] == group.ids[1]
                && m["metadata"]["action"]["requester"]["messageId"] == input["id"])
    );
    assert_eq!(
        actions[0]["metadata"]["action"]["screenBinding"],
        actions[1]["metadata"]["action"]["screenBinding"]
    );
    assert_eq!(
        task_status(&group, &group.ids[1]).await["botScreen"]["task"]["status"],
        "idle"
    );
    assert_eq!(
        task_status(&group, &group.ids[0]).await["botScreen"]["status"],
        "unassigned"
    );
    assert_eq!(executions(&server.worker).await, 2);
    group.close().await;
}
