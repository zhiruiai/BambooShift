mod workspace_support;

use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use workspace_support::Fixture;

async fn history(f: &Fixture) -> (String, Value) {
    let initial = f.bootstrap().await;
    let body = json!({
        "agentId":initial["agents"][0]["id"],
        "conversationId":initial["conversations"][0]["id"],
        "title":"Synthetic history",
        "prompt":"No model is invoked by this fixture.",
        "schedule":"daily:09:00",
        "enabled":false
    });
    let (status, routine) = f
        .request(
            "POST",
            &f.path("/routines"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{routine}");
    let routine_id = routine["id"].as_str().unwrap().to_owned();
    let run_id = uuid::Uuid::new_v4().to_string();
    let result_id = uuid::Uuid::new_v4().to_string();
    let marker = json!({"runId":run_id,"routineId":routine_id,"inputMessageId":run_id});
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let run = json!({
        "runId":run_id,"routineId":routine_id,"agentId":routine["agentId"],
        "conversationId":routine["conversationId"],"inputMessageId":run_id,
        "resultMessageId":result_id,"trigger":"scheduled","status":"completed",
        "startedAt":"2026-11-05T01:00:00.000Z","finishedAt":"2026-11-05T01:00:01.000Z"
    });
    for message in [
        json!({"id":run_id,"role":"system","kind":"text","agentId":routine["agentId"],"conversationId":routine["conversationId"],"content":"Synthetic input","createdAt":run["startedAt"],"metadata":{"routineRun":marker}}),
        json!({"id":result_id,"role":"assistant","kind":"text","agentId":routine["agentId"],"conversationId":routine["conversationId"],"content":"Synthetic result","status":"done","createdAt":run["finishedAt"],"metadata":{"routineRun":marker}}),
    ] {
        store.put(Table::Messages, &message).await.unwrap();
    }
    sqlx::query("INSERT INTO routine_runs(run_id,routine_id,started_at,data) VALUES(?,?,?,?)")
        .bind(&run_id)
        .bind(&routine_id)
        .bind(run["startedAt"].as_str().unwrap())
        .bind(run.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    (routine_id, run)
}

#[tokio::test]
async fn member_views_receive_the_existing_cloud_and_run_history_contracts() {
    let f = Fixture::new().await;
    let (id, run) = history(&f).await;
    let cloud = f
        .request(
            "GET",
            &f.path("/cloud-computer"),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(cloud.0, 200, "{}", cloud.1);
    assert_eq!(cloud.1["configured"], false);
    assert_eq!(cloud.1["state"], "unconfigured");
    let list = f
        .request(
            "GET",
            &f.path(&format!("/routines/{id}/runs")),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(list.0, 200, "{}", list.1);
    assert_eq!(list.1, json!({"routineId":id,"runs":[run]}));
    let item = f
        .request(
            "GET",
            &f.path(&format!(
                "/routines/{id}/runs/{}",
                run["runId"].as_str().unwrap()
            )),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(item.0, 200, "{}", item.1);
    assert_eq!(item.1, run);
    f.close().await;
}

#[tokio::test]
async fn reads_keep_fixed_account_workspace_and_revocation_boundaries() {
    let f = Fixture::new().await;
    let (id, run) = history(&f).await;
    let suffixes = [
        "/cloud-computer".to_owned(),
        format!("/routines/{id}/runs"),
        format!("/routines/{id}/runs/{}", run["runId"].as_str().unwrap()),
    ];
    for suffix in &suffixes {
        for expected in [None, Some(f.owner.as_str())] {
            assert_eq!(
                f.request("GET", &f.path(suffix), None, true, expected)
                    .await
                    .0,
                403
            );
        }
        let foreign = format!("/api/workspaces/{}{suffix}", f.foreign);
        assert_eq!(
            f.request("GET", &foreign, None, false, Some(&f.owner))
                .await
                .0,
            403
        );
    }
    assert!(!f.directory.path().join("spaces").join(&f.foreign).exists());
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    for suffix in &suffixes {
        assert_eq!(
            f.request("GET", &f.path(suffix), None, true, Some(&f.member))
                .await
                .0,
            403
        );
    }
    f.close().await;
}

#[tokio::test]
async fn readable_status_does_not_allow_members_to_start_or_change_work() {
    let f = Fixture::new().await;
    let (id, _) = history(&f).await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let routine = store.get(Table::Routines, &id).await.unwrap();
    let messages = store.list(Table::Messages).await.unwrap();
    for (method, suffix, body) in [
        ("POST", "/cloud-computer/start".to_owned(), json!({})),
        ("POST", format!("/routines/{id}/run"), json!({})),
        ("PATCH", format!("/routines/{id}"), json!({"enabled":true})),
        ("DELETE", format!("/routines/{id}"), json!({})),
    ] {
        let response = f
            .request(method, &f.path(&suffix), Some(body), true, Some(&f.member))
            .await;
        assert_eq!(response.0, 403, "{method} {suffix}: {}", response.1);
    }
    assert_eq!(store.get(Table::Routines, &id).await.unwrap(), routine);
    assert_eq!(store.list(Table::Messages).await.unwrap(), messages);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM routine_runs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    f.close().await;
}
