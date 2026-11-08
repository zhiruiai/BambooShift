mod computer_support;
mod teaching_support;
mod workspace_support;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use teaching_support::{Teaching, called, model, proposal};
use tokio::sync::Semaphore;

#[tokio::test]
async fn restart_marks_uncertain_recordings_interrupted_without_replaying_or_generating() {
    let t = Teaching::new().await;
    t.input(json!({"type":"key","key":"Enter"})).await;
    let retained = t.read().await;
    let config = (*t.f.state.config).clone();
    t.f.state.close().await;
    let path =
        t.f.directory
            .path()
            .join("spaces")
            .join(&t.f.workspace)
            .join("openbot.sqlite");
    let db = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    let mut crash = retained.clone();
    crash["status"] = json!("recording");
    crash["userId"] = json!(t.f.owner);
    crash["sessionId"] = json!("original-session");
    sqlx::query("UPDATE teaching_sessions SET data=?")
        .bind(crash.to_string())
        .execute(&db)
        .await
        .unwrap();
    db.close().await;
    let restored = openbot_backend::db::State::open(config).await.unwrap();
    let ws = restored
        .workspace
        .get(&t.f.workspace, &t.f.workspace)
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM teaching_sessions")
        .fetch_one(&ws.pool)
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["status"], "interrupted");
    assert_eq!(value["reason"], "service_restarted");
    assert_eq!(value["steps"], retained["steps"]);
    assert!(
        ws.list(openbot_backend::workspace::Table::Skills)
            .await
            .unwrap()
            .is_empty()
    );
    restored.close().await;
    t.f.close().await;
}
#[tokio::test]
async fn real_sixty_second_deadline_cancels_the_worker_and_preserves_reviewed_steps() {
    let t = Teaching::new().await;
    t.input(json!({"type":"key","key":"Enter"})).await;
    let saved = t.review().await;
    let gate = Arc::new(Semaphore::new(0));
    let (task, calls, profile) = model(&t.f, proposal(), Some(gate)).await;
    let begin = tokio::time::Instant::now();
    assert_eq!(t.request("POST","/generate",Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile}))).await.0,200);
    called(&calls).await;
    let done = t.settled().await;
    assert_eq!(done["status"], "error");
    assert_eq!(done["reason"], "generation_deadline");
    assert_eq!(done["steps"], saved["steps"]);
    assert_eq!(calls.lock().await.len(), 1);
    assert!(begin.elapsed() >= Duration::from_secs(59));
    assert!(begin.elapsed() < Duration::from_secs(70));
    assert!(
        t.f.bootstrap().await["skills"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    task.abort();
    tokio::time::timeout(Duration::from_secs(5), t.f.close())
        .await
        .unwrap();
}
#[tokio::test]
async fn accepted_recording_survives_a_dropped_http_future_and_stays_single() {
    let t = Teaching::new().await;
    t.request("POST", "/stop", Some(json!({}))).await;
    let ws =
        t.f.state
            .workspace
            .get(&t.f.workspace, &t.f.workspace)
            .await
            .unwrap();
    let block = ws.begin().await.unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let body = json!({"requestId":request,"agentId":t.agent,"conversationId":t.conversation,"leaseId":t.lease["leaseId"]});
    let path = t.f.path("/teaching");
    let future =
        t.f.request("POST", &path, Some(body.clone()), false, Some(&t.f.owner));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), future)
            .await
            .is_err()
    );
    drop(block);
    for _ in 0..100 {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM teaching_sessions WHERE id=?")
            .bind(&request)
            .fetch_one(&ws.pool)
            .await
            .unwrap();
        if count == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, value) =
        t.f.request(
            "GET",
            &t.f.path(&format!("/teaching/{request}")),
            None,
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "recording");
    let (status, replay) =
        t.f.request(
            "POST",
            &t.f.path("/teaching"),
            Some(body),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(value["id"], replay["id"]);
    t.f.request(
        "POST",
        &t.f.path(&format!("/teaching/{request}/cancel")),
        Some(json!({})),
        false,
        Some(&t.f.owner),
    )
    .await;
    t.f.close().await;
}
