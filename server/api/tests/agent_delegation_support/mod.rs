#![allow(dead_code)]
pub use crate::workspace_support::Fixture;
use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, Response},
    routing::post,
};
use futures_util::future::BoxFuture;
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, Semaphore};
pub type Handler = Arc<dyn Fn(Value) -> BoxFuture<'static, Response<Body>> + Send + Sync>;
pub struct Model {
    task: tokio::task::JoinHandle<()>,
    pub url: String,
    pub calls: Arc<Mutex<Vec<Value>>>,
    pub authorization: Arc<Mutex<Vec<String>>>,
}
impl Model {
    pub async fn new(handler: Handler) -> Self {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let records = calls.clone();
        let authorization = Arc::new(Mutex::new(Vec::new()));
        let auth_records = authorization.clone();
        let router = Router::new().route(
            "/v1/chat/completions",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let (handler, records, auth_records) =
                    (handler.clone(), records.clone(), auth_records.clone());
                async move {
                    auth_records.lock().await.push(
                        headers
                            .get("authorization")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or("")
                            .to_owned(),
                    );
                    records.lock().await.push(body.clone());
                    handler(body).await
                }
            }),
        );
        let router = router.layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            task,
            url,
            calls,
            authorization,
        }
    }
    pub fn config(&self) -> Value {
        json!({"provider":"synthetic-delegation","model":"fixture","baseUrl":self.url,"apiKey":"SYNTHETIC_DELEGATION_KEY"})
    }
}
impl Drop for Model {
    fn drop(&mut self) {
        self.task.abort()
    }
}
pub fn response(delta: Value, reason: &str) -> Response<Body> {
    let event = |delta: Value, reason: Option<&str>| {
        format!(
            "data: {}\n\n",
            json!({"id":"synthetic-child","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":reason}]})
        )
    };
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(format!(
            "{}{}data: [DONE]\n\n",
            event(delta, None),
            event(json!({}), Some(reason))
        )))
        .unwrap()
}
pub fn finish(text: &str) -> Response<Body> {
    response(json!({"role":"assistant","content":text}), "stop")
}
pub fn call(name: &str, args: Value) -> Response<Body> {
    response(
        json!({"role":"assistant","tool_calls":[{"index":0,"id":uuid::Uuid::new_v4().to_string(),"type":"function","function":{"name":name,"arguments":args.to_string()}}]}),
        "tool_calls",
    )
}
pub fn role(body: &Value) -> usize {
    let system = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "system")
        .map(|m| m["content"].as_str().unwrap_or(""))
        .collect::<String>();
    (0..4)
        .find(|n| system.contains(&format!("SYNTHETIC_ROLE_{n}")))
        .unwrap_or(9)
}
pub fn has_tool_result(body: &Value) -> bool {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "tool")
}
pub async fn wait_gate(gate: &Semaphore) {
    tokio::time::timeout(std::time::Duration::from_secs(20), gate.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget()
}
pub struct Group {
    pub f: Fixture,
    pub store: Arc<WorkspaceStore>,
    pub cid: String,
    pub ids: Vec<String>,
}
impl Group {
    pub async fn new() -> Self {
        let f = Fixture::new().await;
        let mut ids = Vec::new();
        for index in 0..4 {
            let (status,bot)=f.request("POST",&f.path("/agents"),Some(json!({"name":format!("Synthetic colleague {index}"),"instructions":format!("SYNTHETIC_ROLE_{index}: Complete the assigned synthetic task using exact tool outcomes.")})),false,Some(&f.owner)).await;
            assert_eq!(status, 201, "{bot}");
            ids.push(bot["id"].as_str().unwrap().to_owned());
        }
        let (status, chat) = f
            .request(
                "POST",
                &f.path("/conversations"),
                Some(json!({"title":"Synthetic working group","agentIds":ids,"isGroup":true})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 201, "{chat}");
        let store = f
            .state
            .workspace
            .get(&f.workspace, &f.workspace)
            .await
            .unwrap();
        Self {
            f,
            store,
            cid: chat["id"].as_str().unwrap().to_owned(),
            ids,
        }
    }
    pub async fn configure(&self, model: &Model) {
        let r = self
            .f
            .request(
                "PUT",
                &self.f.path("/settings"),
                Some(model.config()),
                false,
                Some(&self.f.owner),
            )
            .await;
        assert_eq!(r.0, 200, "{}", r.1)
    }
    pub async fn send(&self, text: &str, mode: &str, member: bool) -> Value {
        let actor = if member {
            &self.f.member
        } else {
            &self.f.owner
        };
        let response=self.f.request("POST",&self.f.path(&format!("/conversations/{}/messages",self.cid)),Some(json!({"content":text,"clientId":uuid::Uuid::new_v4().to_string(),"agentId":self.ids[0],"mode":mode})),member,Some(actor)).await;
        assert_eq!(response.0, 202, "{}", response.1);
        response.1["message"].clone()
    }
    pub async fn done(&self) -> Vec<Value> {
        self.done_within(std::time::Duration::from_secs(35)).await
    }
    pub async fn done_for_mentions(&self, input_id: &str) -> Vec<Value> {
        // The active registry can be empty while the queue starts the next Bot.
        let mut updates = self.store.subscribe();
        tokio::time::timeout(Duration::from_secs(35), async {
            loop {
                let input = self
                    .store
                    .get(Table::Messages, input_id)
                    .await
                    .unwrap()
                    .unwrap();
                let recipients = input["delivery"]["mentionTargets"]
                    .as_array()
                    .filter(|recipients| !recipients.is_empty())
                    .expect("the accepted input should have mention receipts");
                if recipients.iter().all(|recipient| {
                    matches!(
                        recipient["state"].as_str(),
                        Some("done" | "error" | "cancelled" | "interrupted")
                    )
                }) {
                    break;
                }
                updates
                    .recv()
                    .await
                    .expect("the workspace should emit delivery updates");
            }
        })
        .await
        .expect("all mentioned Bots should reach a terminal delivery state");
        self.done().await
    }
    pub async fn done_within(&self, timeout: std::time::Duration) -> Vec<Value> {
        tokio::time::timeout(timeout, async {
            loop {
                if self
                    .f
                    .state
                    .agent_runs
                    .requests(&self.f.workspace)
                    .await
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Delegation fixture did not drain its actual processes");
        self.store
            .list(Table::Messages)
            .await
            .unwrap()
            .into_iter()
            .filter(|m| m["conversationId"] == self.cid)
            .collect()
    }
    pub async fn stop(&self) {
        let r = self
            .f
            .request(
                "POST",
                &self.f.path(&format!("/conversations/{}/stop", self.cid)),
                Some(json!({})),
                false,
                Some(&self.f.owner),
            )
            .await;
        assert_eq!(r.0, 200, "{}", r.1);
    }
    pub async fn close(self) {
        self.f.close().await
    }
}
