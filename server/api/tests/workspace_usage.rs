mod usage_support;
mod workspace_support;
use chrono::{Duration, Utc};
use serde_json::Value;
use usage_support::*;
#[tokio::test]
async fn usage_is_actor_scoped_utc_bounded_and_requires_the_expected_account() {
    let f = Fixture::new().await;
    let data = f.bootstrap().await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let today = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    for (index, user, at, provider, tokens, reported) in [
        (1, &f.owner, today.timestamp_millis(), "provider-a", 12, 1),
        (2, &f.member, today.timestamp_millis(), "provider-b", 7, 1),
        (
            3,
            &f.member,
            (today - Duration::days(1)).timestamp_millis(),
            "provider-b",
            0,
            0,
        ),
        (
            4,
            &f.owner,
            (today - Duration::days(7)).timestamp_millis(),
            "provider-old",
            99,
            1,
        ),
        (
            5,
            &f.owner,
            (today + Duration::days(1)).timestamp_millis(),
            "provider-future",
            101,
            1,
        ),
    ] {
        sqlx::query("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(format!("run-{index}"))
            .bind(format!("message-{index}"))
            .bind(at)
            .bind(user)
            .bind(agent)
            .bind(provider)
            .bind("fixture")
            .bind("synthetic-profile")
            .bind(reported)
            .bind(tokens)
            .bind(0)
            .bind(0)
            .bind(0)
            .bind(tokens)
            .execute(&store.pool)
            .await
            .unwrap();
    }
    let owner = usage(&f, false, 7).await;
    let member = usage(&f, true, 7).await;
    assert_eq!(owner["scope"]["visibility"], "workspace");
    assert_eq!(member["scope"]["visibility"], "self");
    assert_eq!(member["scope"]["userId"], f.member);
    assert_eq!(owner["totals"]["modelTurns"], 3);
    assert_eq!(owner["totals"]["totalTokens"], 19);
    assert_eq!(member["totals"]["modelTurns"], 2);
    assert_eq!(member["totals"]["totalTokens"], 7);
    assert_eq!(member["totals"]["unreportedTurns"], 1);
    assert_eq!(owner["byDay"].as_array().unwrap().len(), 2);
    assert_eq!(owner["byBot"].as_array().unwrap().len(), 1);
    assert_eq!(owner["byModel"].as_array().unwrap().len(), 2);
    assert_eq!(owner["period"]["timeZone"], "UTC");
    assert_eq!(owner["cost"], Value::Null);
    assert_eq!(usage(&f, false, 30).await["totals"]["modelTurns"], 4);
    assert_eq!(usage(&f, false, 90).await["totals"]["modelTurns"], 4);
    assert_eq!(
        f.request("GET", &f.path("/usage"), None, false, Some(&f.owner))
            .await
            .1["period"]["days"],
        30
    );
    for query in [
        "days=0",
        "days=8",
        "days=91",
        "days=not-a-number",
        "days=7&userId=other",
    ] {
        assert_eq!(
            f.request(
                "GET",
                &f.path(&format!("/usage?{query}")),
                None,
                false,
                Some(&f.owner)
            )
            .await
            .0,
            400
        );
    }
    for expected in [None, Some(f.member.as_str())] {
        assert_eq!(
            f.request("GET", &f.path("/usage"), None, false, expected)
                .await
                .0,
            403
        );
    }
    assert_eq!(
        f.with_cookie(
            "GET",
            &f.path("/usage"),
            None,
            &format!("openbot_operator={}", f.operator_token),
            Some(&f.owner)
        )
        .await
        .0,
        401
    );
    assert_eq!(
        f.request(
            "GET",
            &format!("/api/workspaces/{}/usage", f.foreign),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        403
    );
    let foreign = f
        .request(
            "GET",
            &format!("/api/workspaces/{}/usage", f.foreign),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(foreign.0, 200);
    assert_eq!(foreign.1["totals"]["modelTurns"], 0);
    assert!(!owner.to_string().contains("run-1"));
    assert!(!owner.to_string().contains("message-1"));
    f.close().await;
}
