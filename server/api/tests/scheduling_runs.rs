mod scheduling_support;
mod workspace_support;
use openbot_backend::workspace::Table;
use scheduling_support::*;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn configuration_is_owner_scoped_and_pause_can_repair_an_orphan() {
    let f = Fixture::new().await;
    let mut r = routine(&f).await;
    let path = f.path(&format!("/routines/{}", r["id"].as_str().unwrap()));
    assert_eq!(
        f.request(
            "PATCH",
            &path,
            Some(json!({"title":"member change"})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    let weekly = f
        .request(
            "PATCH",
            &path,
            Some(json!({"schedule":"weekly:5,1,3:10:00"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(weekly.0, 200, "{}", weekly.1);
    assert_eq!(weekly.1["schedule"], "weekly:1,3,5:10:00");
    for body in [
        json!({"timeZone":"Invalid/Zone"}),
        json!({"schedule":"weekly:1,1:10:00"}),
        json!({"schedule":"interval:0"}),
        json!({"enabled":"yes"}),
    ] {
        assert_eq!(
            f.request("PATCH", &path, Some(body), false, Some(&f.owner))
                .await
                .0,
            400
        );
    }
    let store = store(&f).await;
    r = store
        .get(Table::Routines, r["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    r["conversationId"] = json!("missing");
    r["schedule"] = json!("invalid-legacy");
    store.put(Table::Routines, &r).await.unwrap();
    let paused = f
        .request(
            "PATCH",
            &path,
            Some(json!({"enabled":false})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(paused.0, 200);
    assert_eq!(paused.1["enabled"], false);
    assert_eq!(paused.1["schedule"], "invalid-legacy");
    f.close().await;
}
#[tokio::test]
async fn manual_run_tracks_a_real_pi_result_and_preserves_its_human_requester() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let r = routine(&f).await;
    let id = r["id"].as_str().unwrap();
    let path = f.path(&format!("/routines/{id}/run"));
    assert_eq!(
        f.request("POST", &path, None, true, Some(&f.member))
            .await
            .0,
        403
    );
    let accepted = f.request("POST", &path, None, false, Some(&f.owner)).await;
    assert_eq!(accepted.0, 202, "{}", accepted.1);
    let store = store(&f).await;
    let messages = wait(&store, |m| {
        m.iter()
            .any(|v| v["role"] == "assistant" && v["status"] == "done")
    })
    .await;
    let input = messages
        .iter()
        .find(|v| v["id"] == accepted.1["message"]["id"])
        .unwrap();
    assert_eq!(input["role"], "user");
    assert_eq!(input["userId"], f.owner);
    let history = f
        .request(
            "GET",
            &f.path(&format!("/routines/{id}/runs")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(history.0, 200);
    assert_eq!(history.1["runs"][0]["status"], "completed");
    assert_eq!(history.1["runs"][0]["trigger"], "manual");
    assert!(history.1["runs"][0]["resultMessageId"].is_string());
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert!(!history.1.to_string().contains("SYNTHETIC_SCHEDULE_KEY"));
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn background_schedule_runs_without_an_owner_session_and_claims_only_once() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let mut r = routine(&f).await;
    let store = store(&f).await;
    r["nextRunAt"] = json!("2026-11-05T00:00:00.000Z");
    store.put(Table::Routines, &r).await.unwrap();
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    let clock = at("2026-11-05T00:01:00Z");
    openbot_backend::scheduling::tick(&f.state, clock)
        .await
        .unwrap();
    openbot_backend::scheduling::tick(&f.state, clock)
        .await
        .unwrap();
    let messages = wait(&store, |m| {
        m.iter()
            .any(|v| v["role"] == "assistant" && v["status"] == "done")
    })
    .await;
    let inputs = messages
        .iter()
        .filter(|m| m["role"] == "system")
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 1);
    assert!(inputs[0].get("userId").is_none());
    let row = sqlx::query("SELECT data FROM routine_runs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let run: Value = serde_json::from_str(row.get("data")).unwrap();
    assert_eq!(run["status"], "completed");
    assert_eq!(run["trigger"], "scheduled");
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let next = store
        .get(Table::Routines, r["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next["nextRunAt"], "2026-11-05T01:01:00.000Z");
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn overdue_weekly_work_is_advanced_without_running_on_the_wrong_day() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let mut r = routine(&f).await;
    let store = store(&f).await;
    r["schedule"] = json!("weekly:5:09:00");
    r["nextRunAt"] = json!("2026-11-06T01:00:00.000Z");
    store.put(Table::Routines, &r).await.unwrap();
    openbot_backend::scheduling::tick(&f.state, at("2026-11-07T01:00:00Z"))
        .await
        .unwrap();
    let advanced = store
        .get(Table::Routines, r["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(advanced["nextRunAt"], "2026-11-13T01:00:00.000Z");
    assert_eq!(model.calls.load(Ordering::SeqCst), 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routine_runs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    drop(model);
    f.close().await;
}
