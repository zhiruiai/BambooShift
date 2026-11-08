mod usage_support;
mod workspace_support;
use axum::{Json, Router, body::Body, http::Response, routing::post};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;
use usage_support::*;

#[tokio::test]
async fn real_pi_records_tool_only_and_text_usage_with_frozen_model_and_no_prices_or_payloads() {
    let f = Fixture::new().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (counter, signal, gate) = (calls.clone(), entered.clone(), release.clone());
    let router=Router::new().route("/v1/chat/completions",post(move|Json(body):Json<Value>|{
  let (counter,signal,gate)=(counter.clone(),signal.clone(),gate.clone());async move{
   let count=counter.fetch_add(1,Ordering::SeqCst);assert_eq!(body["model"],"usage-fixture");
   if count==0{signal.add_permits(1);gate.acquire().await.unwrap().forget();}
   let delta=if count==0{json!({"role":"assistant","tool_calls":[{"index":0,"id":"usage-tool","type":"function","function":{"name":"remember","arguments":"{\"content\":\"Synthetic private usage content\",\"category\":\"context\"}"}}]})}else{json!({"role":"assistant","content":"Synthetic usage answer"})};
   let frame=|delta:Value,reason:Option<&str>,usage:Value|format!("data: {}\n\n",json!({"id":format!("turn-{count}"),"object":"chat.completion.chunk","created":1,"model":"usage-fixture","choices":[{"index":0,"delta":delta,"finish_reason":reason}],"usage":usage}));
   let usage=json!({"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":20,"cache_write_tokens":5}});
   Response::builder().header("content-type","text/event-stream").body(Body::from(format!("{}{}data: [DONE]\n\n",frame(delta,None,Value::Null),frame(json!({}),Some(if count==0{"tool_calls"}else{"stop"}),usage)))).unwrap()
  }
 }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let model = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let response=f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-usage","model":"usage-fixture","baseUrl":format!("http://{address}/v1"),"apiKey":"SYNTHETIC_USAGE_KEY"})),false,Some(&f.owner)).await;
    assert_eq!(response.0, 200, "{}", response.1);
    submit(&f, false, "followUp").await;
    tokio::time::timeout(std::time::Duration::from_secs(20), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let response=f.request("PUT",&f.path("/settings"),Some(json!({"provider":"changed-provider","model":"changed-model","baseUrl":"http://127.0.0.1:9/v1","apiKey":"SYNTHETIC_CHANGED_KEY"})),false,Some(&f.owner)).await;
    assert_eq!(response.0, 409);
    // Simulate a later persisted default in this isolated fixture; active runs stay frozen.
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut tx = store.begin().await.unwrap();
    let active = openbot_backend::workspace::WorkspaceStore::get_in(
        &mut tx,
        openbot_backend::workspace::Table::Settings,
        "model",
    )
    .await
    .unwrap()
    .unwrap();
    let id = format!("model-profile:{}", active["profileId"].as_str().unwrap());
    let mut profile = openbot_backend::workspace::WorkspaceStore::get_in(
        &mut tx,
        openbot_backend::workspace::Table::Settings,
        &id,
    )
    .await
    .unwrap()
    .unwrap();
    profile["model"] = json!("changed-model");
    openbot_backend::workspace::WorkspaceStore::put_in(
        &mut tx,
        openbot_backend::workspace::Table::Settings,
        &profile,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    release.add_permits(1);
    done(&f).await;
    let recorded = usage(&f, false, 30).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        recorded["totals"],
        json!({"modelTurns":2,"reportedTurns":2,"unreportedTurns":0,"inputTokens":150,"outputTokens":20,"cacheReadTokens":40,"cacheWriteTokens":10,"totalTokens":220})
    );
    assert_eq!(recorded["byModel"][0]["model"], "usage-fixture");
    assert_eq!(recorded["cost"], Value::Null);
    assert!(
        !recorded
            .to_string()
            .contains("Synthetic private usage content")
    );
    assert!(!recorded.to_string().contains("SYNTHETIC_USAGE_KEY"));
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    sqlx::query("DELETE FROM messages")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(usage(&f, false, 30).await["totals"], recorded["totals"]);
    model.abort();
    f.close().await;
}

#[tokio::test]
async fn repeated_terminal_frames_are_idempotent_and_absent_usage_is_unreported() {
    let mut f = Fixture::new().await;
    fake_worker(&mut f, "normal").await;
    submit(&f, false, "followUp").await;
    done(&f).await;
    let result = usage(&f, false, 30).await;
    assert_eq!(result["totals"]["modelTurns"], 2);
    assert_eq!(result["totals"]["reportedTurns"], 1);
    assert_eq!(result["totals"]["unreportedTurns"], 1);
    assert_eq!(result["totals"]["totalTokens"], 28);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_usage")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let body: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name='model_usage'")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert!(!body.contains("content"));
    assert!(!body.contains("api_key"));
    f.close().await;
}

#[tokio::test]
async fn zero_usage_never_establishes_a_reported_or_free_model_turn() {
    let mut f = Fixture::new().await;
    fake_worker(&mut f, "zero").await;
    submit(&f, false, "followUp").await;
    done(&f).await;
    let result = usage(&f, false, 30).await;
    assert_eq!(result["totals"]["modelTurns"], 2);
    assert_eq!(result["totals"]["reportedTurns"], 0);
    assert_eq!(result["totals"]["unreportedTurns"], 2);
    assert_eq!(result["totals"]["totalTokens"], 0);
    assert_eq!(result["cost"], Value::Null);
    f.close().await;
}

#[tokio::test]
async fn late_usage_after_session_revocation_or_member_removal_is_not_recorded() {
    for revoke_session in [true, false] {
        let mut f = Fixture::new().await;
        let path = fake_worker(&mut f, "held").await;
        submit(&f, true, "followUp").await;
        entered(&path).await;
        if revoke_session {
            sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
                .bind(&f.member)
                .execute(&f.db)
                .await
                .unwrap();
        } else {
            sqlx::query("DELETE FROM memberships WHERE user_id=? AND workspace_id=?")
                .bind(&f.member)
                .bind(&f.workspace)
                .execute(&f.db)
                .await
                .unwrap();
        }
        done(&f).await;
        assert_eq!(usage(&f, false, 30).await["totals"]["modelTurns"], 0);
        f.close().await;
    }
}

#[tokio::test]
async fn old_generation_end_is_ignored_before_new_steer_delivery() {
    let mut f = Fixture::new().await;
    let path = fake_worker(&mut f, "steer").await;
    submit(&f, false, "followUp").await;
    entered(&path).await;
    submit(&f, false, "steer").await;
    done(&f).await;
    let value = usage(&f, false, 30).await;
    assert_eq!(value["totals"]["modelTurns"], 1);
    assert_eq!(value["totals"]["totalTokens"], 5);
    f.close().await;
}
