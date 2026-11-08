#![allow(dead_code, unused_imports)]
pub use crate::agent_delegation_support::{
    Group, Model, call, finish, has_tool_result, role, wait_gate,
};
pub use crate::computer_support::Server;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub async fn configured(group: &Group, model: &Model, vision: bool) {
    let mut config = model.config();
    config["vision"] = json!(vision);
    let (status, body) = group
        .f
        .request(
            "PUT",
            &group.f.path("/settings"),
            Some(config),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{body}");
}
pub async fn connected(group: &Group) -> Server {
    let server = Server::start(&group.f.workspace).await;
    crate::computer_support::connect(&group.f, &server.worker).await;
    server
}
pub async fn snapshot(group: &Group, check: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let snapshot = group.f.bootstrap().await;
            if check(&snapshot) {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Computer agent fixture did not reach the expected state")
}
pub async fn pending(group: &Group) -> Value {
    let data = snapshot(group, |s| {
        s["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["metadata"]["action"]["status"] == "pending")
    })
    .await;
    data["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["metadata"]["action"]["status"] == "pending")
        .unwrap()["metadata"]["action"]
        .clone()
}
pub async fn approve(group: &Group, action: &Value, member: bool) -> (u16, Value) {
    group
        .f
        .request(
            "POST",
            &group.f.path(&format!(
                "/computer/bots/{}/actions/{}/approve",
                action["agentId"].as_str().unwrap(),
                action["id"].as_str().unwrap()
            )),
            Some(json!({})),
            member,
            Some(if member {
                &group.f.member
            } else {
                &group.f.owner
            }),
        )
        .await
}
pub async fn task_status(group: &Group, agent: &str) -> Value {
    let (status, value) = group
        .f
        .request(
            "GET",
            &group.f.path(&format!("/computer/bots/{agent}/status")),
            None,
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value
}
pub fn tool_result(body: &Value) -> Value {
    let text = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .and_then(|m| m["content"].as_str())
        .expect("Missing actual tool response");
    serde_json::from_str(text).expect("Tool response is not JSON")
}
pub fn root_result<'a>(messages: &'a [Value], input: &Value) -> &'a Value {
    messages
        .iter()
        .find(|m| {
            m["role"] == "assistant"
                && m["kind"] == "text"
                && m["metadata"]["inputMessageId"] == input["id"]
        })
        .expect("Missing root result")
}
pub async fn executions(worker: &Arc<crate::computer_support::Worker>) -> usize {
    worker
        .calls
        .lock()
        .await
        .iter()
        .filter(|(path, _)| path.ends_with("/execute") || path.ends_with("/execute-with-frame"))
        .count()
}
