#![allow(dead_code)]
#[allow(unused_imports)]
pub use crate::agent_delegation_support::{Group, Model, call, finish, has_tool_result};
pub use crate::apps_support::Server;
use openbot_backend::{apps, workspace::Table};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

pub fn catalog() -> Vec<Value> {
    vec![
        json!({"name":"read_notes","description":"Read matching synthetic notes without changing them","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]},"annotations":{"readOnlyHint":true}}),
        json!({"name":"write_note","description":"Write a synthetic note","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}},"annotations":{"readOnlyHint":false,"destructiveHint":false}}),
        json!({"name":"unclassified","description":"No declared read semantics","inputSchema":{"type":"object"}}),
        json!({"name":"contradictory","description":"Conflicting risk hints","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true,"destructiveHint":true}}),
    ]
}
pub async fn setup() -> (Group, Server, Value, Value) {
    let mut group = Group::new().await;
    let server = Server::start().await;
    *server.remote.catalog.lock().await = Some(catalog());
    server.remote.bearer.store(true, Ordering::SeqCst);
    group.f.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    let result=group.f.request("POST",&group.f.path("/apps"),Some(json!({"name":"Policy fixture","url":format!("{}/mcp",server.remote.origin),"authType":"bearer","token":"synthetic-access","shared":true})),false,Some(&group.f.owner)).await;
    assert_eq!(result.0, 200, "{}", result.1);
    let routine=group.f.request("POST",&group.f.path("/routines"),Some(json!({"title":"Read daily synthetic notes","prompt":"Call read_notes exactly once with query newer_than:1d, then summarize the real result.","agentId":group.ids[0],"conversationId":group.cid,"schedule":"interval:60","enabled":true})),false,Some(&group.f.owner)).await;
    assert_eq!(routine.0, 201, "{}", routine.1);
    (group, server, result.1, routine.1)
}
pub fn path(g: &Group, c: &Value) -> String {
    g.f.path(&format!("/apps/{}/policies", c["id"].as_str().unwrap()))
}
pub async fn body(g: &Group, c: &Value, r: &Value, name: &str) -> Value {
    let options =
        g.f.request(
            "GET",
            &(path(g, c) + "/options"),
            None,
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(options.0, 200, "{}", options.1);
    let option = options.1["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["tool"]["name"] == name)
        .unwrap();
    let routine = options.1["routines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == r["id"])
        .unwrap();
    json!({"requestId":uuid::Uuid::new_v4().to_string(),"routineId":r["id"],"expectedRoutineRevision":routine["revision"],"connectionRevision":options.1["connectionRevision"],"catalogRevision":options.1["catalogRevision"],"toolName":name,"toolRevision":option["revision"],"arguments":{"query":"newer_than:1d"},"confirmReadOnly":true})
}
pub async fn grant(g: &Group, c: &Value, r: &Value) -> Value {
    let request = body(g, c, r, "read_notes").await;
    let response =
        g.f.request("POST", &path(g, c), Some(request), false, Some(&g.f.owner))
            .await;
    assert_eq!(response.0, 200, "{}", response.1);
    response.1
}
pub async fn schedule(g: &Group, r: &Value) {
    let mut routine = g
        .store
        .get(Table::Routines, r["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    let at = chrono::Utc::now().timestamp_millis();
    routine["nextRunAt"] = json!(
        chrono::DateTime::from_timestamp_millis(at - 10000)
            .unwrap()
            .to_rfc3339()
    );
    g.store.put(Table::Routines, &routine).await.unwrap();
    openbot_backend::scheduling::tick(&g.f.state, at)
        .await
        .unwrap();
}
pub async fn action(g: &Group, status: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            for message in g.store.list(Table::Messages).await.unwrap() {
                if message["metadata"]["appAction"]["status"] == status {
                    return message["metadata"]["appAction"].clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Policy action did not reach expected actual state")
}
pub fn model(c: &Value, name: &str, args: Value) -> crate::agent_delegation_support::Handler {
    let id = c["id"].clone();
    let name = name.to_owned();
    Arc::new(move |body| {
        let (id, name, args) = (id.clone(), name.clone(), args.clone());
        Box::pin(async move {
            if has_tool_result(&body) {
                finish("Used the actual application receipt.")
            } else {
                call(
                    "app_call",
                    json!({"connectionId":id,"toolName":name,"arguments":args}),
                )
            }
        })
    })
}
