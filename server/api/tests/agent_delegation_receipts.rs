mod agent_delegation_support;
mod agent_primary_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, role};
use agent_primary_support::personal;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn last_tool(body: &Value) -> Value {
    let message = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
}

async fn actual_child_receipts(private: bool) {
    let mut group = Group::new().await;
    if private {
        group = personal(group).await;
    }
    if let Some(node) = std::env::var_os("OPENBOT_NODE") {
        Arc::make_mut(&mut group.f.state.config).node_binary = node.into();
    }
    let parent_step = Arc::new(AtomicUsize::new(0));
    let child_step = Arc::new(AtomicUsize::new(0));
    let receipts = Arc::new(Mutex::new(Value::Null));
    let (parent_count, child_count, observed) =
        (parent_step.clone(), child_step.clone(), receipts.clone());
    let target = group.ids[1].clone();
    let model = Model::new(Arc::new(move |body| {
        let (parent, child, observed, target) =
            (parent_count.clone(), child_count.clone(), observed.clone(), target.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                return match child.fetch_add(1, Ordering::SeqCst) {
                    0 => call("workspace_write", json!({"path":"handoff.md","content":"SYNTHETIC_REVIEW_VERSION_1"})),
                    1 => call("workspace_deliver", json!({"path":"handoff.md","expectedSha256":last_tool(&body)["sha256"]})),
                    2 => call("workspace_write", json!({"path":"review-site/index.html","content":"<!doctype html><title>Synthetic review</title><h1>Review this version</h1>"})),
                    3 => call("workspace_deliver_website", json!({"directory":"review-site","title":"Synthetic review","entry":"index.html","files":[{"path":"index.html","sha256":last_tool(&body)["sha256"]}]})),
                    4 => finish("Published the review artifacts. Acceptance checks have not run."),
                    5 => finish("I claim a new imaginary.zip and all tests passed, without using a delivery or test tool."),
                    _ => panic!("Unexpected child request"),
                };
            }
            match parent.fetch_add(1, Ordering::SeqCst) {
                0 => call("workspace_write", json!({"path":"parent-only.md","content":"NOT_A_CHILD_ARTIFACT"})),
                1 => call("workspace_deliver", json!({"path":"parent-only.md","expectedSha256":last_tool(&body)["sha256"]})),
                2 => call("delegate", json!({"agentId":target,"task":"Deliver one review document and one website. Do not claim that tests ran."})),
                3 => {
                    let result = last_tool(&body);
                    assert_eq!(result["status"], "completed");
                    assert_eq!(result["acceptance"], "requires_review");
                    assert_eq!(result["deliveries"]["scope"], "direct_child_run");
                    assert_eq!(result["deliveries"]["truncated"], false);
                    let items = result["deliveries"]["items"].as_array().unwrap();
                    assert_eq!(items.len(), 2, "The parent's artifact must not be attributed to the child");
                    assert_eq!(items[0]["name"], "handoff.md");
                    assert_eq!(items[0]["kind"], "file");
                    assert_eq!(items[1]["kind"], "website_project");
                    assert_eq!(items[1]["project"]["fileCount"], 1);
                    *observed.lock().unwrap() = result;
                    call("delegate", json!({"agentId":target,"task":"Return a text-only result; do not publish anything."}))
                }
                4 => {
                    let result = last_tool(&body);
                    assert_eq!(result["status"], "completed");
                    assert_eq!(result["acceptance"], "requires_review");
                    assert_eq!(result["deliveries"]["items"], json!([]),
                        "Prior child deliveries and new prose claims are not current-run receipts");
                    finish("The first handoff has registered artifacts; the second has no delivery evidence. Product acceptance remains open.")
                }
                _ => panic!("Unexpected parent request"),
            }
        })
    })).await;
    group.configure(&model).await;
    group
        .send(
            "Coordinate a synthetic artifact handoff.",
            "followUp",
            false,
        )
        .await;
    group.done().await;
    let result = receipts.lock().unwrap().clone();
    let messages = group.store.list(Table::Messages).await.unwrap();
    let child = messages
        .iter()
        .find(|message| message["id"] == result["resultMessageId"])
        .unwrap();
    for receipt in result["deliveries"]["items"].as_array().unwrap() {
        let card = messages
            .iter()
            .find(|message| message["id"] == receipt["messageId"])
            .unwrap();
        assert_eq!(card["metadata"]["runId"], child["metadata"]["runId"]);
        assert_eq!(card["conversationId"], child["conversationId"]);
        assert_eq!(card["agentId"], group.ids[1]);
    }
    if private {
        assert_ne!(child["conversationId"], group.cid);
    } else {
        assert_eq!(child["conversationId"], group.cid);
    }
    let receipt = &result["deliveries"]["items"][0];
    let file = group
        .store
        .get(Table::Files, receipt["fileId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(file["source"]["sha256"], receipt["sha256"]);
    let response = group
        .f
        .request(
            "GET",
            &group.f.path(&format!(
                "/files/{}/download",
                receipt["fileId"].as_str().unwrap()
            )),
            None,
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(response.0, 200);
    assert_eq!(response.1["invalid"], "SYNTHETIC_REVIEW_VERSION_1");
    assert_eq!(parent_step.load(Ordering::SeqCst), 5);
    assert_eq!(child_step.load(Ordering::SeqCst), 6);
    drop(model);
    group.close().await;
}

#[tokio::test]
async fn group_handoff_returns_only_the_current_childs_published_artifacts() {
    actual_child_receipts(false).await;
}

#[tokio::test]
async fn primary_dm_handoff_returns_receipts_without_importing_unrelated_history() {
    actual_child_receipts(true).await;
}
