#![allow(dead_code)]
use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

pub const SOURCE: &str = "https://example.com/public-research";
pub struct Provider {
    pub origin: String,
    pub requests: Arc<AtomicUsize>,
    pub hold: Arc<AtomicBool>,
    pub arrived: Arc<Semaphore>,
    pub release: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl Provider {
    pub async fn new() -> Self {
        let requests = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(AtomicBool::new(false));
        let arrived = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let (count, gate, entered, resume) = (
            requests.clone(),
            hold.clone(),
            arrived.clone(),
            release.clone(),
        );
        let app = Router::new().route("/mcp", post(move |Json(body): Json<Value>| {
            let (count, gate, entered, resume) = (count.clone(), gate.clone(), entered.clone(), resume.clone());
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                    if gate.swap(false, Ordering::SeqCst)
                        || body["params"]["arguments"]["query"] == "delayed result"
                    {
                    entered.add_permits(1);
                    resume.acquire().await.unwrap().forget();
                }
                let args = &body["params"]["arguments"];
                if args["query"] == "rate limited" {
                    return (StatusCode::TOO_MANY_REQUESTS, "PRIVATE_RAW_PROVIDER_ERROR").into_response();
                }
                let result = if body["params"]["name"] == "web_fetch_exa" {
                    let text = if args["urls"][0] == SOURCE {
                        format!("# Verified public page\nURL: {SOURCE}\n\nPRIVATE_BODY_NOT_FOR_RECEIPT")
                    } else { "No content found for the provided URL(s).".into() };
                    json!({"content":[{"type":"text","text":text}]})
                } else if args["query"] == "empty result" {
                    json!({"structuredContent":{"results":[]}})
                } else {
                    json!({"structuredContent":{"results":[{"title":"Verified public source","url":SOURCE,"text":"PRIVATE_SNIPPET_NOT_FOR_RECEIPT"}]}})
                };
                Json(json!({"jsonrpc":"2.0","id":1,"result":result})).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            origin,
            requests,
            hold,
            arrived,
            release,
            task,
        }
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub fn cards(messages: &[Value]) -> Vec<&Value> {
    messages
        .iter()
        .filter(|message| message["kind"] == "web_research")
        .collect()
}
pub fn last_tool(body: &Value) -> &str {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}
