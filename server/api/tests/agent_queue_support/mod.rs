#![allow(dead_code)]
pub use crate::workspace_support::Fixture;
use axum::{Json, Router, body::Body, http::Response, routing::post};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
pub struct Model {
    task: tokio::task::JoinHandle<()>,
    pub entered: Arc<Semaphore>,
    pub release: Arc<Semaphore>,
    pub calls: Arc<Mutex<Vec<Value>>>,
}
impl Model {
    pub async fn new(f: &Fixture) -> Self {
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let calls = Arc::new(Mutex::new(vec![]));
        let (signal, gate, records) = (entered.clone(), release.clone(), calls.clone());
        let router=Router::new().route("/v1/chat/completions",post(move|Json(body):Json<Value>|{let (signal,gate,records)=(signal.clone(),gate.clone(),records.clone());async move{
            let n={let mut records=records.lock().await;records.push(body);records.len()};signal.add_permits(1);if n==1{gate.acquire().await.unwrap().forget();}
            let event=|delta:Value,reason:Option<&str>|format!("data: {}\n\n",json!({"id":"synthetic-queue","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":reason}]}));
            Response::builder().header("content-type","text/event-stream").body(Body::from(format!("{}{}data: [DONE]\n\n",event(json!({"role":"assistant","content":format!("Synthetic response {n}")}),None),event(json!({}),Some("stop"))))).unwrap()
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (status,body)=f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-queue","model":"fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_QUEUE_KEY"})),false,Some(&f.owner)).await;
        assert_eq!(status, 200, "{body}");
        Self {
            task,
            entered,
            release,
            calls,
        }
    }
    pub async fn wait(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(20), self.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
}
impl Drop for Model {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn submit(f: &Fixture, cid: &str, content: &str, mode: &str, member: bool) -> Value {
    let actor = if member { &f.member } else { &f.owner };
    let result = f
        .request(
            "POST",
            &f.path(&format!("/conversations/{cid}/messages")),
            Some(
                json!({"content":content,"clientId":uuid::Uuid::new_v4().to_string(),"mode":mode}),
            ),
            member,
            Some(actor),
        )
        .await;
    assert_eq!(result.0, 202, "{}", result.1);
    result.1["message"].clone()
}
pub async fn wait(f: &Fixture, check: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let state = f.bootstrap().await;
            if check(&state) {
                return state;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
