mod workspace_support;
use axum::{Json, Router, body::Body, http::Response, routing::post};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use workspace_support::Fixture;

async fn wait_for(f: &Fixture, check: impl Fn(&Value) -> bool) -> Value {
    let end = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let snapshot = f.bootstrap().await;
        if check(&snapshot) {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < end,
            "Agent fixture timed out: {snapshot}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
fn sse(delta: Value, reason: &str) -> Response<Body> {
    let frame = |delta: Value, reason: Option<&str>| {
        format!(
            "data: {}\n\n",
            json!({"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":reason}]})
        )
    };
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(format!(
            "{}{}data: [DONE]\n\n",
            frame(delta, None),
            frame(json!({}), Some(reason))
        )))
        .unwrap()
}
async fn model(f: &Fixture) -> (tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let app=Router::new().route("/v1/chat/completions",post(move|Json(body):Json<Value>|{
        let calls=calls.clone();async move{
            let n=calls.fetch_add(1,Ordering::SeqCst);
            assert!(body["tools"].as_array().unwrap().iter().any(|tool|tool["function"]["name"]=="remember"));
            if n==0{sse(json!({"role":"assistant","tool_calls":[{"index":0,"id":"synthetic-tool","type":"function","function":{"name":"remember","arguments":"{\"content\":\"Synthetic Rust-owned preference\",\"category\":\"preference\"}"}}]}),"tool_calls")}
            else{sse(json!({"role":"assistant","content":"Saved through the Rust host."}),"stop")}
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (status,body)=f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-agent","model":"fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_PRIVATE_KEY"})),false,Some(&f.owner)).await;
    assert_eq!(status, 200, "{body}");
    (task, count)
}
#[tokio::test]
async fn real_pi_process_returns_tools_to_rust_and_only_rust_persists_memory() {
    let f = Fixture::new().await;
    let (model, calls) = model(&f).await;
    let snapshot = f.bootstrap().await;
    let cid = snapshot["conversations"][0]["id"].as_str().unwrap();
    let agent = snapshot["agents"][0]["id"].as_str().unwrap();
    let request = json!({"content":"Save the supplied synthetic preference.","clientId":uuid::Uuid::new_v4().to_string(),"agentId":agent,"mode":"followUp"});
    let (status, response) = f
        .request(
            "POST",
            &f.path(&format!("/conversations/{cid}/messages")),
            Some(request.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 202, "{response}");
    let final_state = wait_for(&f, |s| {
        s["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "assistant" && m["status"] == "done")
    })
    .await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(final_state["conversations"][0]["unread"], 1);
    assert!(
        final_state["conversations"][0]["readThrough"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(
        final_state["memories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["content"] == "Synthetic Rust-owned preference" && m["agentId"] == agent)
    );
    assert!(!final_state.to_string().contains("SYNTHETIC_PRIVATE_KEY"));
    let repeated = f
        .request(
            "POST",
            &f.path(&format!("/conversations/{cid}/messages")),
            Some(request.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(repeated.0, 202);
    assert_eq!(repeated.1["message"]["id"], response["message"]["id"]);
    let changed = f
        .request(
            "POST",
            &f.path(&format!("/conversations/{cid}/messages")),
            Some(
                json!({"content":"Different input","clientId":request["clientId"],"agentId":agent}),
            ),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(changed.0, 409);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(f.bootstrap().await["conversations"][0]["unread"], 1);
    model.abort();
    f.close().await;
}
#[tokio::test]
async fn missing_model_preserves_the_input_and_reports_failure_without_recreating_or_replaying() {
    let f = Fixture::new().await;
    let snapshot = f.bootstrap().await;
    let cid = snapshot["conversations"][0]["id"].as_str().unwrap();
    let request = json!({"content":"Synthetic task without a configured model","clientId":uuid::Uuid::new_v4().to_string()});
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!("/conversations/{cid}/messages")),
            Some(request.clone()),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        202
    );
    let state = wait_for(&f, |s| {
        s["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "assistant" && m["status"] == "error")
    })
    .await;
    assert!(
        state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "user" && m["content"] == request["content"])
    );
    assert_eq!(state["agents"][0]["status"], "idle");
    assert_eq!(state["conversations"][0]["unread"], 1);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    assert!(store.list(Table::Memories).await.unwrap().is_empty());
    f.close().await;
}
