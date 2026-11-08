mod usage_support;
mod workspace_support;

use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, Response},
    routing::post,
};
use openbot_backend::{
    agent::{complete_cancellable, complete_profile_cancellable},
    workspace::{WorkspaceAccess, access, model},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use usage_support::*;

async fn actor(f: &Fixture) -> WorkspaceAccess {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("openbot_account={}", f.owner_token)
            .parse()
            .unwrap(),
    );
    headers.insert("x-openbot-expected-user", f.owner.parse().unwrap());
    access::require(&f.state, &headers, &f.workspace, true, true)
        .await
        .unwrap()
}

#[tokio::test]
async fn default_and_explicit_profile_completions_record_actual_pi_usage_as_system_assistance() {
    let f = Fixture::new().await;
    let models = Arc::new(Mutex::new(Vec::new()));
    let observed = models.clone();
    let router = Router::new().route("/v1/chat/completions",post(move |Json(body): Json<Value>| {
        observed.lock().unwrap().push(body["model"].clone());
        async move {
            assert!(body.get("tools").is_none_or(|v|v.as_array().is_some_and(Vec::is_empty)));
            let frame = |delta:Value,usage:Value,reason:Option<&str>| format!("data: {}\n\n",json!({"id":"completion-fixture","object":"chat.completion.chunk","created":1,"model":body["model"],"choices":[{"index":0,"delta":delta,"finish_reason":reason}],"usage":usage}));
            let data = format!("{}{}data: [DONE]\n\n",frame(json!({"role":"assistant","content":"Synthetic structured completion"}),Value::Null,None),frame(json!({}),json!({"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}),Some("stop")));
            Response::builder().header("content-type","text/event-stream").body(Body::from(data)).unwrap()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let response = f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-completion","model":"default-fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_COMPLETION_KEY"})),false,Some(&f.owner)).await;
    assert_eq!(response.0, 200, "{}", response.1);
    let response = f.request("POST",&f.path("/model-profiles"),Some(json!({"name":"Secondary fixture","provider":"synthetic-completion","model":"explicit-fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_SECONDARY_KEY","activate":false})),false,Some(&f.owner)).await;
    assert_eq!(response.0, 201, "{}", response.1);
    let profile_id = response.1["profile"]["id"].as_str().unwrap();
    let access = actor(&f).await;
    let store = access.store(&f.state).await.unwrap();
    let explicit = model::runtime_profile_config(&store, profile_id)
        .await
        .unwrap();
    let (cancel, receiver) = watch::channel(false);
    assert_eq!(
        complete_cancellable(
            &f.state,
            &access,
            "Synthetic system",
            "Synthetic prompt",
            receiver.clone()
        )
        .await
        .unwrap(),
        "Synthetic structured completion"
    );
    assert_eq!(
        complete_profile_cancellable(
            &f.state,
            &access,
            &explicit,
            "Synthetic teaching system",
            "Synthetic prompt",
            receiver
        )
        .await
        .unwrap(),
        "Synthetic structured completion"
    );
    assert!(!*cancel.borrow());
    assert_eq!(
        *models.lock().unwrap(),
        vec![json!("default-fixture"), json!("explicit-fixture")]
    );
    let value = usage(&f, false, 30).await;
    assert_eq!(value["totals"]["modelTurns"], 2);
    assert_eq!(value["totals"]["totalTokens"], 22);
    assert_eq!(value["totals"]["reportedTurns"], 2);
    assert_eq!(value["byModel"].as_array().unwrap().len(), 2);
    assert_eq!(value["byBot"].as_array().unwrap().len(), 1);
    assert_eq!(value["byBot"][0]["agentId"], Value::Null);
    assert_eq!(value["cost"], Value::Null);
    assert!(!value.to_string().contains("Synthetic prompt"));
    assert!(!value.to_string().contains("SYNTHETIC_"));
    assert_eq!(f.bootstrap().await["settings"]["model"], "default-fixture");
    server.abort();
    f.close().await;
}

#[tokio::test]
async fn completion_duplicate_terminal_events_record_once() {
    let mut f = Fixture::new().await;
    fake_worker(&mut f, "normal").await;
    let access = actor(&f).await;
    let (_cancel, receiver) = watch::channel(false);
    complete_cancellable(
        &f.state,
        &access,
        "Synthetic system",
        "Synthetic prompt",
        receiver,
    )
    .await
    .unwrap();
    let value = usage(&f, false, 30).await;
    assert_eq!(value["totals"]["modelTurns"], 1);
    assert_eq!(value["totals"]["totalTokens"], 28);
    f.close().await;
}

#[tokio::test]
async fn cancelled_or_revoked_completion_cannot_record_a_late_terminal_event() {
    for revoke in [false, true] {
        let mut f = Fixture::new().await;
        let path = fake_worker(&mut f, "held").await;
        let access = actor(&f).await;
        let (cancel, receiver) = watch::channel(false);
        let state = f.state.clone();
        let task = tokio::spawn(async move {
            complete_cancellable(
                &state,
                &access,
                "Synthetic system",
                "Synthetic prompt",
                receiver,
            )
            .await
        });
        entered(&path).await;
        if revoke {
            sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
                .bind(&f.owner)
                .execute(&f.db)
                .await
                .unwrap();
        } else {
            cancel.send_replace(true);
        }
        assert!(task.await.unwrap().is_err());
        let store = f
            .state
            .workspace
            .get(&f.workspace, &f.workspace)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM model_usage")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0
        );
        f.close().await;
    }
}
