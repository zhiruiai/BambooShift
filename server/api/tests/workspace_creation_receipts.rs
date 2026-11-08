mod workspace_support;

use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use workspace_support::Fixture;

async fn group(f: &Fixture) -> (Value, Value) {
    let initial = f.bootstrap().await;
    let second = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(json!({"name":"Second synthetic Bot"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(second.0, 201, "{}", second.1);
    let body = json!({
        "kind":"group","requestId":uuid::Uuid::new_v4().to_string(),
        "title":"Synthetic recovery group",
        "agentIds":[initial["agents"][0]["id"],second.1["id"]]
    });
    let result = f
        .request(
            "POST",
            &f.path("/creation-requests"),
            Some(body.clone()),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(result.0, 201, "{}", result.1);
    assert_eq!(result.1["status"], "created");
    (body, result.1)
}

#[tokio::test]
async fn malformed_legacy_groups_are_missing_in_reads_replays_and_close_receipts() {
    let f = Fixture::new().await;
    let (body, accepted) = group(&f).await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let before_agents = store.list(Table::Agents).await.unwrap();
    let before_chats = store.list(Table::Conversations).await.unwrap().len();
    let path = f.path(&format!(
        "/creation-requests/{}",
        body["requestId"].as_str().unwrap()
    ));
    for ids in [
        json!([]),
        json!([accepted["agentIds"][0], accepted["agentIds"][0]]),
        Value::Null,
    ] {
        let mut damaged = accepted["conversation"].clone();
        damaged["agentIds"] = ids;
        store.put(Table::Conversations, &damaged).await.unwrap();
        for (method, endpoint, payload) in [
            ("GET", path.clone(), None),
            ("POST", f.path("/creation-requests"), Some(body.clone())),
            ("POST", format!("{path}/cancel"), Some(json!({}))),
        ] {
            let reply = f
                .request(method, &endpoint, payload, true, Some(&f.member))
                .await;
            assert_eq!(reply.0, 200, "{method} {endpoint}: {}", reply.1);
            assert_eq!(reply.1["status"], "missing");
            assert_eq!(reply.1["requestId"], accepted["requestId"]);
            assert_eq!(reply.1["conversationId"], accepted["conversationId"]);
            assert_eq!(reply.1["agentIds"], accepted["agentIds"]);
            assert_eq!(reply.1["agents"], json!([]));
            assert!(reply.1.get("conversation").is_none());
        }
        assert_eq!(
            store
                .get(Table::Conversations, damaged["id"].as_str().unwrap())
                .await
                .unwrap(),
            Some(damaged)
        );
        assert_eq!(store.list(Table::Agents).await.unwrap(), before_agents);
        assert_eq!(
            store.list(Table::Conversations).await.unwrap().len(),
            before_chats
        );
    }
    let receipts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM creation_requests")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(receipts, 1);
    f.close().await;
}

#[tokio::test]
async fn a_valid_existing_group_reduced_to_one_member_keeps_its_original_receipt() {
    let f = Fixture::new().await;
    let (body, accepted) = group(&f).await;
    let conversation = accepted["conversationId"].as_str().unwrap();
    let current_ids = json!([accepted["agentIds"][0]]);
    let changed = f
        .request(
            "PATCH",
            &f.path(&format!("/conversations/{conversation}")),
            Some(json!({"agentIds":current_ids})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(changed.0, 200, "{}", changed.1);
    let receipt = f
        .request(
            "GET",
            &f.path(&format!(
                "/creation-requests/{}",
                body["requestId"].as_str().unwrap()
            )),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(receipt.0, 200, "{}", receipt.1);
    assert_eq!(receipt.1["status"], "created");
    assert_eq!(receipt.1["agentIds"], accepted["agentIds"]);
    assert_eq!(receipt.1["conversation"]["agentIds"], current_ids);
    assert_eq!(receipt.1["agents"].as_array().unwrap().len(), 1);
    f.close().await;
}
