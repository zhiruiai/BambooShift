#![allow(dead_code)]
use crate::workspace_support::Fixture;
use axum::{Json, Router, body::Body, http::Response, routing::post};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
pub fn member(key: &str, name: &str) -> Value {
    json!({"key":key,"kind":"create","name":name,"role":"Researcher","description":"Synthetic profile","instructions":"Report actual results","avatar":"orb","color":"#7c3aed","assignment":"Synthetic assignment"})
}
pub fn proposal() -> Value {
    json!({"title":"Synthetic team","summary":"Review synthetic information","leadKey":"a","members":[member("a","Research"),member("b","Check")]})
}
fn sse(text: String) -> Response<Body> {
    let first = json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]});
    let end = json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(format!(
            "data: {first}\n\ndata: {end}\n\ndata: [DONE]\n\n"
        )))
        .unwrap()
}
pub async fn model(
    f: &Fixture,
    output: Value,
    hold: Option<Arc<tokio::sync::Notify>>,
) -> (tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |Json(body): Json<Value>| {
            let counter = counter.clone();
            let output = output.clone();
            let hold = hold.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                assert!(
                    body.get("tools")
                        .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)),
                    "Planner must have no executable tools"
                );
                assert!(!body.to_string().contains("SYNTHETIC_PRIVATE_KEY"));
                if let Some(hold) = hold {
                    hold.notified().await;
                }
                sse(output.to_string())
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let(status,result)=f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-team","model":"fixture","baseUrl":format!("http://{addr}/v1"),"apiKey":"SYNTHETIC_PRIVATE_KEY"})),false,Some(&f.owner)).await;
    assert_eq!(status, 200, "{result}");
    (task, calls)
}
pub async fn ready(f: &Fixture, id: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let (status, plan) = f
            .request(
                "GET",
                &f.path(&format!("/bot-team-plans/{id}")),
                None,
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 200, "{plan}");
        if plan["status"] != "generating" {
            return plan;
        }
        assert!(tokio::time::Instant::now() < deadline, "planner timed out");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
pub async fn seed(f: &Fixture, draft: Value) -> Value {
    f.bootstrap().await;
    let plan = json!({"id":uuid::Uuid::new_v4().to_string(),"requestId":uuid::Uuid::new_v4().to_string(),"revision":uuid::Uuid::new_v4().to_string(),"goal":"Synthetic goal","status":"ready","draft":draft,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"});
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    sqlx::query("INSERT INTO bot_team_plans(id,request_id,data) VALUES(?,?,?)")
        .bind(plan["id"].as_str())
        .bind(plan["requestId"].as_str())
        .bind(json!({"plan":plan,"catalog":{}}).to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    plan
}
pub fn commit(plan: &Value) -> Value {
    json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":plan["revision"],"draft":plan["draft"]})
}
