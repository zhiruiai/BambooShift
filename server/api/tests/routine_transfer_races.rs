mod agent_queue_support;
mod routine_transfer_support;
mod workspace_support;
use openbot_backend::workspace::Table;
use routine_transfer_support::{Transfer, idle};
use std::time::Duration;

#[tokio::test]
async fn an_accepted_real_pi_run_and_queued_input_cannot_be_transferred_or_stolen() {
    let t = Transfer::new().await;
    let model = agent_queue_support::Model::new(&t.f).await;
    let path = t.f.path(&format!(
        "/routines/{}/run",
        t.routine["id"].as_str().unwrap()
    ));
    assert_eq!(
        t.f.request("POST", &path, None, false, Some(&t.f.owner))
            .await
            .0,
        202
    );
    model.wait().await;
    agent_queue_support::submit(
        &t.f,
        t.routine["conversationId"].as_str().unwrap(),
        "Synthetic queued follow-up",
        "followUp",
        false,
    )
    .await;
    let before = t.current().await;
    let body = t.body();
    let (status, _) = t.send(&body).await;
    assert_eq!(status, 409);
    assert_eq!(t.current().await, before);
    assert_eq!(t.get(body["requestId"].as_str().unwrap()).await.0, 404);
    model.release.add_permits(1);
    idle(&t.f).await;
    assert_eq!(t.send(&body).await.0, 200);
    let messages = t.store().await.list(Table::Messages).await.unwrap();
    for message in messages.iter().filter(|m| m["role"] == "assistant") {
        assert_eq!(message["agentId"], t.routine["agentId"]);
        assert_eq!(message["conversationId"], t.routine["conversationId"]);
    }
    t.f.close().await;
}
#[tokio::test]
async fn session_revocation_while_waiting_for_the_transaction_rolls_back_binding_and_receipt() {
    let t = Transfer::new().await;
    let ws = t.store().await;
    let block = ws.begin().await.unwrap();
    let body = t.body();
    let result=async {
        let request=t.send(&body);tokio::pin!(request);
        tokio::select! {result=&mut request=>panic!("Transfer should wait for SQLite: {result:?}"), _=tokio::time::sleep(Duration::from_millis(100))=>{}}
        sqlx::query("DELETE FROM account_sessions WHERE user_id=?").bind(&t.f.owner).execute(&t.f.db).await.unwrap();drop(block);
        request.await
    }.await;
    assert_eq!(result.0, 403, "{}", result.1);
    assert_eq!(
        ws.get(Table::Routines, t.routine["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap(),
        t.routine
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM routine_transfers")
        .fetch_one(&ws.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    t.f.close().await;
}
#[tokio::test]
async fn simultaneous_same_request_never_creates_a_second_receipt_or_plan() {
    let t = Transfer::new().await;
    let body = t.body();
    let (a, b) = tokio::join!(t.send(&body), t.send(&body));
    assert!([a.0, b.0].contains(&200));
    assert!([200, 409].contains(&a.0) && [200, 409].contains(&b.0));
    let original = if a.0 == 200 { a.1 } else { b.1 };
    assert_eq!(t.get(body["requestId"].as_str().unwrap()).await.1, original);
    assert_eq!(t.send(&body).await.1, original);
    let ws = t.store().await;
    assert_eq!(ws.list(Table::Routines).await.unwrap().len(), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM routine_transfers")
        .fetch_one(&ws.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    t.f.close().await;
}
