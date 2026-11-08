#![allow(dead_code)]
pub use crate::workspace_support::Fixture;
use axum::{Json, Router, body::Body, http::Response, routing::post};
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

pub async fn personal() -> Fixture {
    let f = Fixture::new().await;
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    f
}
pub async fn primary(f: &Fixture) -> Value {
    let state = f.bootstrap().await;
    let response=f.request("PUT",&f.path("/primary-bot"),Some(json!({"mode":"select","expectedRevision":state["primaryBot"]["revision"],"agentId":state["agents"][0]["id"],"checkIn":{"enabled":false,"time":"09:00"}})),false,Some(&f.owner)).await;
    assert_eq!(response.0, 200, "{}", response.1);
    response.1
}
pub fn request(primary: &Value) -> Value {
    json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedPrimaryRevision":primary["revision"],"content":"PRIVATE_SOURCE_WRAPPER: I prefer concise answers and morning planning."})
}
pub async fn store(f: &Fixture) -> Arc<WorkspaceStore> {
    f.state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap()
}
pub async fn receipt(f: &Fixture, id: &str) -> (u16, Value) {
    f.request(
        "GET",
        &f.path(&format!("/memory-imports/{id}")),
        None,
        false,
        Some(&f.owner),
    )
    .await
}
pub async fn wait(f: &Fixture, id: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(25), async {
        loop {
            let (status, value) = receipt(f, id).await;
            assert_eq!(status, 200, "{value}");
            if !["queued", "delivered", "running"].contains(&value["status"].as_str().unwrap_or(""))
            {
                return value;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
pub struct Model {
    task: tokio::task::JoinHandle<()>,
    pub calls: Arc<Mutex<Vec<Value>>>,
}
impl Model {
    pub async fn new(f: &Fixture) -> Self {
        let calls = Arc::new(Mutex::new(vec![]));
        let saved = calls.clone();
        let app=Router::new().route("/v1/chat/completions",post(move|Json(body):Json<Value>|{let saved=saved.clone();async move {
   let n={let mut records=saved.lock().await;records.push(body);records.len()};
   let event=|delta:Value,reason:Option<&str>|format!("data: {}\n\n",json!({"id":"synthetic-import","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":reason}]}));
   let (delta,reason)=if n==1 {(json!({"role":"assistant","tool_calls":[{"index":0,"id":"remember-batch","type":"function","function":{"name":"remember","arguments":json!({"memories":[{"content":"Prefers concise answers","category":"preference"},{"content":"Plans in the morning","category":"preference"}]}).to_string()}}]}),"tool_calls")} else {(json!({"role":"assistant","content":"Synthetic import processed."}),"stop")};
   Response::builder().header("content-type","text/event-stream").body(Body::from(format!("{}{}data: [DONE]\n\n",event(delta,None),event(json!({}),Some(reason))))).unwrap()
  }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert_eq!(f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-import","model":"fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_IMPORT_KEY"})),false,Some(&f.owner)).await.0,200);
        Self { task, calls }
    }
}
impl Drop for Model {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn count_inputs(store: &WorkspaceStore) -> usize {
    store
        .list(Table::Messages)
        .await
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user" && m["metadata"].get("memoryImport").is_some())
        .count()
}
