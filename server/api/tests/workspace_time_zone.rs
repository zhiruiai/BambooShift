mod workspace_support;
use chrono::{DateTime, NaiveDate};
use openbot_backend::workspace::{Table, time_zone};
use serde_json::json;
use workspace_support::Fixture;
fn at(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp_millis()
}
#[test]
fn calendar_schedules_skip_gaps_choose_only_earliest_fold_and_intervals_use_elapsed_minutes() {
    let ny = json!("America/New_York");
    assert_eq!(
        time_zone::next("daily:02:30", at("2024-03-10T00:00:00Z"), Some(&ny)).unwrap(),
        "2024-03-11T06:30:00.000Z"
    );
    assert_eq!(
        time_zone::next("daily:01:30", at("2024-11-03T05:29:00Z"), Some(&ny)).unwrap(),
        "2024-11-03T05:30:00.000Z"
    );
    assert_eq!(
        time_zone::next("daily:01:30", at("2024-11-03T05:31:00Z"), Some(&ny)).unwrap(),
        "2024-11-04T06:30:00.000Z"
    );
    assert_eq!(
        time_zone::next("interval:90", at("2024-11-03T05:30:00Z"), Some(&ny)).unwrap(),
        "2024-11-03T07:00:00.000Z"
    );
    assert_eq!(
        time_zone::next("weekly:7:02:30", at("2024-03-10T00:00:00Z"), Some(&ny)).unwrap(),
        "2024-03-17T06:30:00.000Z"
    );
}
#[test]
fn half_hour_transitions_quarter_hour_zones_and_skipped_dates_are_real_calendar_cases() {
    let lord = json!("Australia/Lord_Howe");
    assert!(
        time_zone::slot(
            NaiveDate::from_ymd_opt(2024, 10, 6).unwrap(),
            "02:15",
            Some(&lord)
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        time_zone::next(
            "daily:09:00",
            at("2024-01-01T00:00:00Z"),
            Some(&json!("Asia/Kathmandu"))
        )
        .unwrap(),
        "2024-01-01T03:15:00.000Z"
    );
    let apia = json!("Pacific/Apia");
    assert!(
        time_zone::slot(
            NaiveDate::from_ymd_opt(2011, 12, 30).unwrap(),
            "09:00",
            Some(&apia)
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        time_zone::next("daily:09:00", at("2011-12-29T20:00:00Z"), Some(&apia)).unwrap(),
        "2011-12-30T19:00:00.000Z"
    );
    assert_eq!(
        time_zone::next("daily:09:00", at("2024-01-01T00:00:00Z"), None).unwrap(),
        "2024-01-01T01:00:00.000Z"
    );
}
#[test]
fn schedule_and_zone_validation_is_strict_and_normalizes_weekday_order() {
    for zone in [
        json!(null),
        json!(""),
        json!("+08:00"),
        json!("Invalid/Timezone"),
        json!(["UTC"]),
    ] {
        assert!(time_zone::normalize(&zone).is_err());
    }
    assert_eq!(
        time_zone::normalize(&json!("asia/shanghai")).unwrap(),
        "Asia/Shanghai"
    );
    assert_eq!(
        time_zone::normalize(&json!("US/Eastern")).unwrap(),
        "America/New_York"
    );
    for invalid in [
        "daily:9:00",
        "daily:24:00",
        "weekly:1,1:09:00",
        "interval:0",
        "interval:525601",
        "interval:+1",
        "weekly:8:12:30",
    ] {
        assert!(time_zone::parse(invalid).is_err(), "{invalid}");
    }
    assert_eq!(
        time_zone::normalize_schedule("weekly:5,1,3:09:00").unwrap(),
        "weekly:1,3,5:09:00"
    );
}
#[tokio::test]
async fn timezone_owner_cas_does_not_rewrite_existing_tasks_or_primary_records() {
    let f = Fixture::new().await;
    let _ = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let task = json!({"id":"task","schedule":"daily:09:00","nextRunAt":"2030-01-01T01:00:00.000Z","agentId":"old","timeZone":"Asia/Shanghai"});
    store.put(Table::Routines, &task).await.unwrap();
    let old = json!({"available":true,"revision":uuid::Uuid::new_v4().to_string(),"agentId":null,"conversationId":null,"checkIn":{"enabled":false,"time":"09:00"}});
    sqlx::query("INSERT INTO primary_bot(id,data) VALUES('primary',?)")
        .bind(old.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    let path = f.path("/workspace-time-zone");
    let (status, member) = f.request("GET", &path, None, true, Some(&f.member)).await;
    assert_eq!(status, 200);
    assert_eq!(member["timeZone"], "Asia/Shanghai");
    let body = json!({"expectedRevision":"unset","timeZone":"America/New_York"});
    let (status, _) = f
        .request("PUT", &path, Some(body.clone()), true, Some(&f.member))
        .await;
    assert_eq!(status, 403);
    let (status, next) = f
        .request("PUT", &path, Some(body.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(status, 200);
    assert_ne!(next["revision"], "unset");
    let (status, _) = f
        .request("PUT", &path, Some(body), false, Some(&f.owner))
        .await;
    assert_eq!(status, 409);
    assert_eq!(
        store.get(Table::Routines, "task").await.unwrap(),
        Some(task)
    );
    let persisted: String = sqlx::query_scalar("SELECT data FROM primary_bot")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&persisted).unwrap(),
        old
    );
    f.close().await;
}
