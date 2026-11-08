#![allow(dead_code)]
pub use crate::workspace_support::Fixture;
use axum::{Json, Router, body::Body, http::Response, routing::post};
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

pub struct Model {
    task: tokio::task::JoinHandle<()>,
    pub calls: Arc<AtomicUsize>,
    pub with_tools: Arc<AtomicUsize>,
}
impl Model {
    pub async fn new(f: &Fixture) -> Self {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let with_tools = Arc::new(AtomicUsize::new(0));
        let tools = with_tools.clone();
        let router=Router::new().route("/v1/chat/completions",post(move|Json(body):Json<Value>|{let count=count.clone();let tools=tools.clone();async move{
            count.fetch_add(1,Ordering::SeqCst);if body["tools"].as_array().is_some_and(|t|!t.is_empty()){tools.fetch_add(1,Ordering::SeqCst);}
            let event=|delta:Value,reason:Option<&str>|format!("data: {}\n\n",json!({"id":"synthetic-schedule","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":reason}]}));
            Response::builder().header("content-type","text/event-stream").body(Body::from(format!("{}{}data: [DONE]\n\n",event(json!({"role":"assistant","content":"Synthetic completed scheduled work."}),None),event(json!({}),Some("stop"))))).unwrap()
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let result=f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-scheduler","model":"fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_SCHEDULE_KEY"})),false,Some(&f.owner)).await;
        assert_eq!(result.0, 200, "{}", result.1);
        Self {
            task,
            calls,
            with_tools,
        }
    }
}
impl Drop for Model {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn store(f: &Fixture) -> Arc<WorkspaceStore> {
    f.state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap()
}
pub async fn routine(f: &Fixture) -> Value {
    let s = f.bootstrap().await;
    let body = json!({"agentId":s["agents"][0]["id"],"conversationId":s["conversations"][0]["id"],"title":"Synthetic schedule","prompt":"Produce a synthetic work summary.","schedule":"interval:60","enabled":true,"timeZone":"Asia/Shanghai"});
    let result = f
        .request(
            "POST",
            &f.path("/routines"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(result.0, 201, "{}", result.1);
    result.1
}
pub async fn wait(store: &WorkspaceStore, check: impl Fn(&Vec<Value>) -> bool) -> Vec<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let messages = store.list(Table::Messages).await.unwrap();
            if check(&messages) {
                return messages;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
pub fn at(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp_millis()
}
