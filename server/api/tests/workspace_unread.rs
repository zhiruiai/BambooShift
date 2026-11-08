mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use workspace_support::Fixture;

fn chat(data: &Value) -> &Value {
    &data["conversations"][0]
}
#[tokio::test]
async fn terminal_delivery_bootstrap_and_read_patch_are_actor_scoped_and_observed() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let cid = chat(&initial)["id"].as_str().unwrap();
    let make = |id: &str, status: &str| json!({"id":id,"conversationId":cid,"agentId":initial["agents"][0]["id"],"role":"assistant","kind":"text","status":status,"content":"Synthetic completion"});
    store
        .put(Table::Messages, &make("result-a", "running"))
        .await
        .unwrap();
    assert_eq!(chat(&f.bootstrap().await)["unread"], 0);
    store
        .put(Table::Messages, &make("result-a", "done"))
        .await
        .unwrap();
    let first = f.bootstrap().await;
    assert_eq!(chat(&first)["unread"], 1);
    store
        .put(Table::Messages, &make("result-b", "done"))
        .await
        .unwrap();
    let path = f.path(&format!("/conversations/{cid}"));
    let (status, receipt) = f
        .request(
            "PATCH",
            &path,
            Some(json!({"read":true,"readThrough":chat(&first)["readThrough"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["unread"], 1);
    let (status, member) = f
        .request("GET", &f.path("/bootstrap"), None, true, Some(&f.member))
        .await;
    assert_eq!(status, 200);
    assert_eq!(chat(&member)["unread"], 2);
    let (status, _) = f
        .request(
            "PATCH",
            &path,
            Some(json!({"read":true})),
            true,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 403);
    let (status, _) = f
        .request(
            "PATCH",
            &path,
            Some(json!({"read":true,"readThrough":-1})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 400);
    let mut changed_events = store.subscribe();
    let (status, _) = f
        .request(
            "PATCH",
            &path,
            Some(json!({"read":true,"readThrough":chat(&member)["readThrough"]})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200);
    let event = changed_events.try_recv().unwrap();
    assert_eq!(event.event, "update");
    assert_eq!(event.data, json!({}));
    assert_eq!(chat(&f.bootstrap().await)["unread"], 1);
    let (_, member) = f
        .request("GET", &f.path("/bootstrap"), None, true, Some(&f.member))
        .await;
    assert_eq!(chat(&member)["unread"], 0);
    let mut events = store.subscribe();
    let (status, _) = f
        .request(
            "PATCH",
            &path,
            Some(json!({"read":true,"readThrough":chat(&member)["readThrough"]})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert!(events.try_recv().is_err());
    for suffix in ["/bootstrap", "/events"] {
        let (status, _) = f
            .request("GET", &f.path(suffix), None, true, Some(&f.owner))
            .await;
        assert_eq!(status, 403);
    }
    f.close().await;
}
