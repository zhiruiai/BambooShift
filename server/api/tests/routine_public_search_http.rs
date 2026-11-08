mod routine_transfer_support;
mod workspace_support;

use openbot_backend::workspace::Table;
use routine_transfer_support::{Transfer, config};
use serde_json::{Value, json};

async fn grant_revision(t: &Transfer, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT revision FROM routine_public_search_grants WHERE routine_id=?")
        .bind(id)
        .fetch_optional(&t.store().await.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn exact_queries_require_owner_and_a_current_snapshot_and_are_dropped_on_transfer() {
    let mut t = Transfer::new().await;
    let id = t.routine["id"].as_str().unwrap().to_owned();
    let path = t.f.path(&format!("/routines/{id}"));
    let initial = config(&t.routine);
    assert!(initial.get("publicSearchQueries").is_none());
    for invalid in [
        json!(["OpenBot docs", " OpenBot docs "]),
        json!(["a", "b", "c", "d", "e"]),
        json!(["line\nbreak"]),
        json!(["🧪".repeat(81)]),
        json!("not-an-array"),
    ] {
        let (status, value) =
            t.f.request(
                "PATCH",
                &path,
                Some(json!({"expectedRoutine":initial,"publicSearchQueries":invalid})),
                false,
                Some(&t.f.owner),
            )
            .await;
        assert_eq!(status, 400, "{value}");
        assert_eq!(value["code"], "ROUTINE_SEARCH_INVALID");
    }
    let approved = json!({"expectedRoutine":initial,"publicSearchQueries":["  OpenBot docs  ","Rust release notes"]});
    assert_eq!(
        t.f.request(
            "PATCH",
            &path,
            Some(approved.clone()),
            true,
            Some(&t.f.member)
        )
        .await
        .0,
        403
    );
    let no_snapshot =
        t.f.request(
            "PATCH",
            &path,
            Some(json!({"publicSearchQueries":["Rust release notes"]})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(no_snapshot.0, 409, "{}", no_snapshot.1);
    assert_eq!(no_snapshot.1["code"], "ROUTINE_SEARCH_SCOPE_CHANGED");
    let (status, routine) =
        t.f.request(
            "PATCH",
            &path,
            Some(approved.clone()),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{routine}");
    assert_eq!(
        routine["publicSearchQueries"],
        json!(["OpenBot docs", "Rust release notes"])
    );
    assert!(routine.get("publicSearchGrant").is_none());
    let before_pause = grant_revision(&t, &id).await.unwrap();
    let stale =
        t.f.request("PATCH", &path, Some(approved), false, Some(&t.f.owner))
            .await;
    assert_eq!(stale.0, 409);
    assert_eq!(stale.1["code"], "ROUTINE_SEARCH_SCOPE_CHANGED");

    for enabled in [false, true] {
        let (status, changed) =
            t.f.request(
                "PATCH",
                &path,
                Some(json!({"enabled":enabled})),
                false,
                Some(&t.f.owner),
            )
            .await;
        assert_eq!(status, 200, "{changed}");
        assert_eq!(
            changed["publicSearchQueries"],
            routine["publicSearchQueries"]
        );
    }
    assert_ne!(
        grant_revision(&t, &id).await.as_deref(),
        Some(before_pause.as_str())
    );
    t.routine = t.current().await;
    let stale =
        t.f.request(
            "PATCH",
            &path,
            Some(json!({"expectedRoutine":initial,"publicSearchQueries":[]})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(stale.0, 409);
    let cleared =
        t.f.request(
            "PATCH",
            &path,
            Some(json!({"expectedRoutine":config(&t.routine),"publicSearchQueries":[]})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(cleared.0, 200, "{}", cleared.1);
    assert!(cleared.1.get("publicSearchQueries").is_none());
    assert!(grant_revision(&t, &id).await.is_none());
    let current =
        t.f.request(
            "PATCH",
            &path,
            Some(json!({"expectedRoutine":config(&cleared.1),"publicSearchQueries":["Rust news"]})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(current.0, 200);
    t.routine = current.1;
    let (status, receipt) = t.send(&t.body()).await;
    assert_eq!(status, 200, "{receipt}");
    assert!(receipt["routine"].get("publicSearchQueries").is_none());
    assert!(grant_revision(&t, &id).await.is_none());
    t.f.close().await;
}

#[tokio::test]
async fn operation_create_replays_once_and_group_or_shared_bots_cannot_receive_search_permissions()
{
    let t = Transfer::new().await;
    let endpoint = t.f.path("/routine-operations");
    let mut body = config(&t.routine);
    body["kind"] = json!("create");
    body["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    body["publicSearchQueries"] = json!(["Release announcements"]);
    let submit = |body: Value| {
        t.f.request("POST", &endpoint, Some(body), false, Some(&t.f.owner))
    };
    let (status, receipt) = submit(body.clone()).await;
    assert_eq!(status, 201, "{receipt}");
    assert_eq!(submit(body.clone()).await, (200, receipt.clone()));
    let id = receipt["routineId"].as_str().unwrap();
    assert!(grant_revision(&t, id).await.is_some());

    let store = t.store().await;
    let agent = t.routine["agentId"].as_str().unwrap();
    let chat = t.routine["conversationId"].as_str().unwrap();
    let mut group = store
        .get(Table::Conversations, chat)
        .await
        .unwrap()
        .unwrap();
    group["id"] = json!(uuid::Uuid::new_v4().to_string());
    group["isGroup"] = json!(true);
    group["agentIds"] = json!([agent, t.target["id"]]);
    store.put(Table::Conversations, &group).await.unwrap();
    let mut shared = store.get(Table::Agents, agent).await.unwrap().unwrap();
    for conversation in [&group["id"], &t.routine["conversationId"]] {
        if conversation == &t.routine["conversationId"] {
            shared["sharedBot"] = json!({"shareId":uuid::Uuid::new_v4().to_string()});
            store.put(Table::Agents, &shared).await.unwrap();
        }
        let mut input = config(&t.routine);
        input["conversationId"] = conversation.clone();
        input["publicSearchQueries"] = json!(["Release announcements"]);
        let (status, error) =
            t.f.request(
                "POST",
                &t.f.path("/routines"),
                Some(input),
                false,
                Some(&t.f.owner),
            )
            .await;
        assert_eq!(status, 409, "{error}");
        assert_eq!(error["code"], "ROUTINE_SEARCH_TARGET");
    }
    t.f.close().await;
}
