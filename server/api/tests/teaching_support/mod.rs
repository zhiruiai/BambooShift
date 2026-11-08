#![allow(dead_code)]
use crate::{computer_support, workspace_support::Fixture};
use axum::{Json, Router, body::Body, http::Response, routing::post};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, Semaphore};
pub struct Teaching {
    pub f: Fixture,
    pub worker: computer_support::Server,
    pub agent: String,
    pub conversation: String,
    pub lease: Value,
    pub session: Value,
}
impl Teaching {
    pub async fn new() -> Self {
        let f = Fixture::new().await;
        let data = f.bootstrap().await;
        let agent = data["agents"][0]["id"].as_str().unwrap().to_owned();
        let conversation = data["conversations"][0]["id"].as_str().unwrap().to_owned();
        let worker = computer_support::Server::start(&f.workspace).await;
        computer_support::connect(&f, &worker.worker).await;
        computer_support::prepared(&f, &agent).await;
        let (status, lease) = f
            .request(
                "POST",
                &f.path(&format!("/computer/bots/{agent}/takeover/start")),
                Some(json!({})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 200, "{lease}");
        let (status,session)=f.request("POST",&f.path("/teaching"),Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"agentId":agent,"conversationId":conversation,"leaseId":lease["leaseId"]})),false,Some(&f.owner)).await;
        assert_eq!(status, 200, "{session}");
        Self {
            f,
            worker,
            agent,
            conversation,
            lease,
            session,
        }
    }
    pub fn path(&self, suffix: &str) -> String {
        self.f.path(&format!(
            "/teaching/{}{suffix}",
            self.session["id"].as_str().unwrap()
        ))
    }
    pub async fn request(&self, method: &str, suffix: &str, body: Option<Value>) -> (u16, Value) {
        self.f
            .request(method, &self.path(suffix), body, false, Some(&self.f.owner))
            .await
    }
    pub async fn input(&self, mut body: Value) -> (u16, Value) {
        body["leaseId"] = self.lease["leaseId"].clone();
        self.f
            .request(
                "POST",
                &self
                    .f
                    .path(&format!("/computer/bots/{}/takeover/input", self.agent)),
                Some(body),
                false,
                Some(&self.f.owner),
            )
            .await
    }
    pub async fn read(&self) -> Value {
        let (status, value) = self.request("GET", "", None).await;
        assert_eq!(status, 200, "{value}");
        value
    }
    pub async fn review(&self) -> Value {
        let (status, saved) = self.request("POST", "/stop", Some(json!({}))).await;
        assert_eq!(status, 200, "{saved}");
        let steps = saved["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| json!({"id":s["id"],"note":"Fill the synthetic form field"}))
            .collect::<Vec<_>>();
        let(status,saved)=self.request("PATCH","",Some(json!({"expectedRevision":saved["revision"],"goal":"Teach how to fill a form without storing its values","steps":steps}))).await;
        assert_eq!(status, 200, "{saved}");
        saved
    }
    pub async fn settled(&self) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(70);
        loop {
            let v = self.read().await;
            if !["recording", "generating"].contains(&v["status"].as_str().unwrap_or("")) {
                return v;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "teaching did not settle: {v}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
pub fn proposal() -> Value {
    json!({"name":"Form preparation","description":"Review the field before submitting","content":"1. Open the form.\n2. Ask the user for the value and type [USER_VALUE].\n3. Confirm the result. Do not store passwords."})
}
pub async fn model(
    f: &Fixture,
    output: Value,
    hold: Option<Arc<Semaphore>>,
) -> (tokio::task::JoinHandle<()>, Arc<Mutex<Vec<Value>>>, String) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let received = calls.clone();
    let app=Router::new().route("/v1/chat/completions",post(move|Json(body):Json<Value>|{let calls=received.clone();let output=output.clone();let hold=hold.clone();async move{
        assert!(body.get("tools").is_none_or(|v|v.as_array().is_some_and(Vec::is_empty)));
        calls.lock().await.push(body);
        if let Some(gate)=hold{gate.acquire().await.unwrap().forget();}
        let first=json!({"id":"synthetic-teaching","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":output.to_string()},"finish_reason":null}]});
        let end=json!({"id":"synthetic-teaching","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        Response::builder().header("content-type","text/event-stream").body(Body::from(format!("data: {first}\n\ndata: {end}\n\ndata: [DONE]\n\n"))).unwrap()
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let(status,profile)=f.request("POST",&f.path("/model-profiles"),Some(json!({"name":"Synthetic teaching model","provider":"teaching-fixture","model":"fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_MODEL_CREDENTIAL","activate":false})),false,Some(&f.owner)).await;
    assert_eq!(status, 201, "{profile}");
    let id = profile["profile"]["id"].as_str().unwrap().to_owned();
    (task, calls, id)
}
pub async fn called(calls: &Mutex<Vec<Value>>) {
    for _ in 0..300 {
        if !calls.lock().await.is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("Model was not called");
}
