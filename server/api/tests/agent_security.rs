mod workspace_support;
use axum::{Json, Router, body::Body, http::Response, routing::post};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;
use workspace_support::Fixture;

struct HeldModel {
    task: tokio::task::JoinHandle<()>,
    entered: Arc<Semaphore>,
}
impl HeldModel {
    async fn start(f: &Fixture) -> Self {
        let entered = Arc::new(Semaphore::new(0));
        let signal = entered.clone();
        let router = Router::new().route(
            "/v1/chat/completions",
            post(move |Json(_): Json<Value>| {
                let signal = signal.clone();
                async move {
                    signal.add_permits(1);
                    std::future::pending::<()>().await;
                    Response::new(Body::empty())
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let (status, body) = f.request("PUT", &f.path("/settings"), Some(json!({"provider":"synthetic-held","model":"fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_HELD_KEY"})), false, Some(&f.owner)).await;
        assert_eq!(status, 200, "{body}");
        Self { task, entered }
    }
    async fn wait(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(20), self.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
}
impl Drop for HeldModel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn submit(f: &Fixture, member: bool) -> (String, Value) {
    let snapshot = f.bootstrap().await;
    let cid = snapshot["conversations"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let actor = if member { &f.member } else { &f.owner };
    let (status, response) = f.request("POST", &f.path(&format!("/conversations/{cid}/messages")), Some(json!({"content":"Synthetic held request","clientId":uuid::Uuid::new_v4().to_string()})), member, Some(actor)).await;
    assert_eq!(status, 202, "{response}");
    (cid, response["message"].clone())
}
async fn completed(f: &Fixture) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let snapshot = f.bootstrap().await;
            if snapshot["runningRequests"] == json!([])
                && snapshot["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["role"] == "assistant" && m["status"] == "error")
            {
                return snapshot;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn running_projection_is_safe_and_owner_cannot_stop_another_requester() {
    let f = Fixture::new().await;
    let model = HeldModel::start(&f).await;
    let (cid, input) = submit(&f, true).await;
    model.wait().await;
    let snapshot = f.bootstrap().await;
    assert_eq!(snapshot["runningConversationIds"], json!([cid]));
    assert_eq!(
        snapshot["runningRequests"],
        json!([{"conversationId":cid,"requester":{"userId":f.member,"name":"member@example.test","messageId":input["id"]}}])
    );
    for secret in [
        "SYNTHETIC_HELD_KEY",
        "session_id",
        "authorize",
        "storage_key",
    ] {
        assert!(!snapshot["runningRequests"].to_string().contains(secret));
    }
    let stopped = f
        .request(
            "POST",
            &f.path(&format!("/conversations/{cid}/stop")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(stopped.0, 403, "{}", stopped.1);
    assert_eq!(
        f.bootstrap().await["runningRequests"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!("/conversations/{cid}/stop")),
            None,
            true,
            Some(&f.member)
        )
        .await
        .0,
        200
    );
    let finished = completed(&f).await;
    assert_eq!(finished["agents"][0]["status"], "idle");
    assert!(finished["memories"].as_array().unwrap().is_empty());
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn revoking_the_original_session_stops_execution_without_replaying_input() {
    let f = Fixture::new().await;
    let model = HeldModel::start(&f).await;
    let (cid, input) = submit(&f, true).await;
    model.wait().await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    let snapshot = completed(&f).await;
    assert_eq!(snapshot["agents"][0]["status"], "idle");
    assert_eq!(
        snapshot["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["id"] == input["id"])
            .count(),
        1
    );
    assert!(snapshot["memories"].as_array().unwrap().is_empty());
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!("/conversations/{cid}/stop")),
            None,
            true,
            Some(&f.member)
        )
        .await
        .0,
        401
    );
    drop(model);
    f.close().await;
}
