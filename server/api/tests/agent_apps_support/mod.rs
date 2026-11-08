#![allow(dead_code)]
pub use crate::agent_delegation_support::{Group, Model, call, finish};
pub use crate::apps_support::Server;
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub async fn setup() -> (Group, Server, Value) {
    let mut group = Group::new().await;
    let server = Server::start().await;
    group.f.state.apps = Arc::new(
        openbot_backend::apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap(),
    );
    server
        .remote
        .bearer
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (status, connection) = group
        .f
        .request(
            "POST",
            &group.f.path("/apps"),
            Some(connection_body(&server, "Personal notes")),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{connection}");
    (group, server, connection)
}
pub fn connection_body(server: &Server, name: &str) -> Value {
    json!({"name":name,"url":format!("{}/mcp",server.remote.origin),"authType":"bearer","token":"synthetic-access","shared":true})
}
pub async fn pending(store: &WorkspaceStore) -> Value {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            for message in store.list(Table::Messages).await.unwrap() {
                if message["metadata"]["appAction"]["status"] == "pending" {
                    return message["metadata"]["appAction"].clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("The actual application approval did not appear")
}
pub async fn decide(group: &Group, action: &Value, member: bool) -> (u16, Value) {
    group
        .f
        .request(
            "POST",
            &group.f.path(&format!(
                "/app-actions/{}/decision",
                action["id"].as_str().unwrap()
            )),
            Some(json!({"approve":true})),
            member,
            Some(if member {
                &group.f.member
            } else {
                &group.f.owner
            }),
        )
        .await
}
pub fn tool_result(body: &Value) -> Value {
    let tool = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .expect("Missing actual tool response");
    serde_json::from_str(tool["content"].as_str().unwrap()).unwrap()
}
pub fn root_result<'a>(messages: &'a [Value], input: &Value) -> &'a Value {
    messages
        .iter()
        .find(|m| {
            m["role"] == "assistant"
                && m["kind"] == "text"
                && m["metadata"]["inputMessageId"] == input["id"]
        })
        .unwrap()
}
pub async fn drained(state: &openbot_backend::db::State, workspace: &str) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !state.agent_runs.requests(workspace).await.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
