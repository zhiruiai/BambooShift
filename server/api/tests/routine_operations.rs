mod scheduling_support;
mod workspace_support;
use openbot_backend::{config::Config, db::State, workspace::Table};
use scheduling_support::*;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

fn expected(r: &Value) -> Value {
    json!({"agentId":r["agentId"],"conversationId":r["conversationId"],"title":r["title"],"prompt":r["prompt"],"schedule":r["schedule"],"timeZone":r["timeZone"],"enabled":r["enabled"]})
}
fn run_request(r: &Value) -> Value {
    json!({"kind":"run","routineId":r["id"],"requestId":uuid::Uuid::new_v4().to_string(),"expectedRoutine":expected(r)})
}
async fn get(f: &Fixture, id: &str) -> (u16, Value) {
    f.request(
        "GET",
        &f.path(&format!("/routine-operations/{id}")),
        None,
        false,
        Some(&f.owner),
    )
    .await
}
async fn cancel(f: &Fixture, id: &str) -> (u16, Value) {
    f.request(
        "POST",
        &f.path(&format!("/routine-operations/{id}/cancel")),
        Some(json!({})),
        false,
        Some(&f.owner),
    )
    .await
}

#[tokio::test]
async fn concurrent_creation_replays_exact_receipt_after_defaults_change_without_new_entities() {
    let f = Fixture::new().await;
    let s = f.bootstrap().await;
    let body = json!({"kind":"create","requestId":uuid::Uuid::new_v4().to_string(),"agentId":s["agents"][0]["id"],"title":"A useful plan","prompt":"Synthetic output"});
    let path = f.path("/routine-operations");
    let (a, b) = tokio::join!(
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner)),
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner))
    );
    assert!([200, 201].contains(&a.0), "{}", a.1);
    assert!([200, 201].contains(&b.0), "{}", b.1);
    assert_eq!(a.1, b.1);
    let store = store(&f).await;
    let rows = store.list(Table::Routines).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["timeZone"], "Asia/Shanghai");
    assert_eq!(
        f.request(
            "PUT",
            &f.path("/workspace-time-zone"),
            Some(json!({"expectedRevision":"unset","timeZone":"America/New_York"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    let replay = f
        .request("POST", &path, Some(body.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(replay.1, a.1);
    let mut changed = body.clone();
    changed["title"] = json!("Different");
    assert_eq!(
        f.request("POST", &path, Some(changed), false, Some(&f.owner))
            .await
            .0,
        409
    );
    assert_eq!(store.list(Table::Messages).await.unwrap().len(), 0);
    assert_eq!(cancel(&f, body["requestId"].as_str().unwrap()).await.1, a.1);
    store
        .delete(Table::Routines, a.1["routineId"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        get(&f, body["requestId"].as_str().unwrap()).await.1["status"],
        "missing"
    );
    f.close().await;
}
#[tokio::test]
async fn cancellation_fence_survives_restart_and_late_post_never_runs() {
    let mut f = Fixture::new().await;
    let r = routine(&f).await;
    let body = run_request(&r);
    let id = body["requestId"].as_str().unwrap();
    assert_eq!(cancel(&f, id).await.1["status"], "not_submitted");
    assert_eq!(get(&f, id).await.0, 410);
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    let late = f
        .request(
            "POST",
            &f.path("/routine-operations"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(late.0, 409);
    assert_eq!(late.1["code"], "ROUTINE_OPERATION_CLOSED");
    assert_eq!(get(&f, id).await.0, 410);
    let store = store(&f).await;
    assert_eq!(store.list(Table::Messages).await.unwrap().len(), 0);
    assert_eq!(store.list(Table::Routines).await.unwrap()[0], r);
    f.close().await;
}
#[tokio::test]
async fn real_pi_terminal_evidence_is_once_and_accepted_cancel_does_not_stop_or_replay() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let r = routine(&f).await;
    let body = run_request(&r);
    let path = f.path("/routine-operations");
    let (a, b) = tokio::join!(
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner)),
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner))
    );
    assert!([200, 202].contains(&a.0), "{}", a.1);
    assert!([200, 202].contains(&b.0), "{}", b.1);
    assert_eq!(a.1["messageId"], b.1["messageId"]);
    let id = body["requestId"].as_str().unwrap();
    let accepted = cancel(&f, id).await;
    assert_ne!(accepted.1["status"], "not_submitted");
    let store = store(&f).await;
    wait(&store, |m| {
        m.iter()
            .any(|v| v["role"] == "assistant" && v["status"] == "done")
    })
    .await;
    let final_receipt = get(&f, id).await.1;
    assert_eq!(final_receipt["status"], "completed");
    assert!(final_receipt["resultMessageId"].is_string());
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let replay = f
        .request("POST", &path, Some(body.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(replay.1, final_receipt);
    store
        .delete(Table::Routines, r["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(get(&f, id).await.1, final_receipt);
    store.put(Table::Routines, &r).await.unwrap();
    let history_path = f.path(&format!(
        "/routines/{}/runs/{}",
        r["id"].as_str().unwrap(),
        final_receipt["messageId"].as_str().unwrap()
    ));
    let history = f
        .request("GET", &history_path, None, false, Some(&f.owner))
        .await;
    assert_eq!(history.0, 200);
    assert_eq!(
        history.1["resultMessageId"],
        final_receipt["resultMessageId"]
    );
    store
        .delete(
            Table::Messages,
            final_receipt["messageId"].as_str().unwrap(),
        )
        .await
        .unwrap();
    let missing_input = f
        .request("GET", &history_path, None, false, Some(&f.owner))
        .await
        .1;
    assert!(missing_input.get("inputMessageId").is_none());
    assert_eq!(
        missing_input["resultMessageId"],
        final_receipt["resultMessageId"]
    );
    let mut result = store
        .get(
            Table::Messages,
            final_receipt["resultMessageId"].as_str().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    result["metadata"]["routineRun"]["routineId"] = json!("another-routine");
    store.put(Table::Messages, &result).await.unwrap();
    assert!(
        f.request("GET", &history_path, None, false, Some(&f.owner))
            .await
            .1
            .get("resultMessageId")
            .is_none()
    );
    assert_eq!(get(&f, id).await.1["status"], "missing");
    store
        .delete(Table::Routines, r["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(get(&f, id).await.1["status"], "missing");
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn stale_snapshot_and_receipt_failure_leave_no_message_schedule_or_run_write() {
    let f = Fixture::new().await;
    let r = routine(&f).await;
    let mut body = run_request(&r);
    body["expectedRoutine"]["prompt"] = json!("stale");
    assert_eq!(
        f.request(
            "POST",
            &f.path("/routine-operations"),
            Some(body),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    let store = store(&f).await;
    sqlx::query("CREATE TRIGGER fail_receipt BEFORE INSERT ON routine_operations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").execute(&store.pool).await.unwrap();
    let failed = f
        .request(
            "POST",
            &f.path("/routine-operations"),
            Some(run_request(&r)),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(failed.0, 500);
    assert_eq!(store.list(Table::Routines).await.unwrap()[0], r);
    assert!(store.list(Table::Messages).await.unwrap().is_empty());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routine_runs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!f.state.agent_runs.workspace_busy(&f.workspace).await);
    f.close().await;
}
#[tokio::test]
async fn operation_endpoints_require_live_owner_expected_identity_and_workspace() {
    let f = Fixture::new().await;
    let r = routine(&f).await;
    let body = run_request(&r);
    let id = body["requestId"].as_str().unwrap();
    for (method, path, input) in [
        ("POST", f.path("/routine-operations"), Some(body.clone())),
        ("GET", f.path(&format!("/routine-operations/{id}")), None),
        (
            "POST",
            f.path(&format!("/routine-operations/{id}/cancel")),
            Some(json!({})),
        ),
    ] {
        assert_eq!(
            f.request(method, &path, input.clone(), true, Some(&f.member))
                .await
                .0,
            403
        );
        assert_eq!(
            f.request(method, &path, input.clone(), false, Some(&f.member))
                .await
                .0,
            403
        );
        assert_eq!(
            f.request(method, &path, input.clone(), false, None).await.0,
            403
        );
        assert_eq!(
            f.with_cookie(
                method,
                &path,
                input,
                &format!("openbot_operator={}", f.operator_token),
                Some(&f.owner)
            )
            .await
            .0,
            401
        );
    }
    assert_eq!(get(&f, id).await.0, 404);
    f.close().await;
}
