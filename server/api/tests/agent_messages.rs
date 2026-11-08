mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn replies_use_server_snapshots_and_retries_bind_the_original_reply() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    let bot = boot["agents"][0]["id"].as_str().unwrap();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store.put(Table::Messages,&json!({"id":id,"conversationId":cid,"agentId":bot,"role":"assistant","kind":"text","content":"Server-owned quote","createdAt":"2026-11-06T00:00:00Z","status":"done"})).await.unwrap();
    let request = json!({"content":"A synthetic reply","clientId":"stable-client-request","replyToMessageId":id});
    let path = f.path(&format!("/conversations/{cid}/messages"));
    let (status, accepted) = f
        .request("POST", &path, Some(request.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(status, 202, "{accepted}");
    assert_eq!(
        accepted["message"]["replyTo"]["content"],
        "Server-owned quote"
    );
    assert_eq!(
        accepted["message"]["replyTo"]["author"],
        boot["agents"][0]["name"]
    );
    let repeated = f
        .request("POST", &path, Some(request.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(repeated.0, 202);
    assert_eq!(repeated.1["message"]["id"], accepted["message"]["id"]);
    let mut changed = request;
    changed.as_object_mut().unwrap().remove("replyToMessageId");
    assert_eq!(
        f.request("POST", &path, Some(changed), false, Some(&f.owner))
            .await
            .0,
        409
    );
    let wrong = uuid::Uuid::new_v4().to_string();
    store.put(Table::Messages,&json!({"id":wrong,"conversationId":"another-conversation","role":"user","content":"Private other conversation"})).await.unwrap();
    assert_eq!(f.request("POST",&path,Some(json!({"content":"Cannot quote this","clientId":"other-request","replyToMessageId":wrong})),false,Some(&f.owner)).await.0,400);
    f.close().await;
}
#[tokio::test]
async fn reactions_keep_individual_membership_and_reject_forged_actors() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store.put(Table::Messages,&json!({"id":id,"conversationId":cid,"role":"user","content":"Synthetic shared message"})).await.unwrap();
    let path = f.path(&format!("/messages/{id}/reactions"));
    for (member, actor) in [(false, &f.owner), (true, &f.member)] {
        assert_eq!(
            f.request(
                "POST",
                &path,
                Some(json!({"emoji":"👍","active":true})),
                member,
                Some(actor)
            )
            .await
            .0,
            200
        );
    }
    let result = f
        .request(
            "POST",
            &path,
            Some(json!({"emoji":"👍","active":false})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(result.0, 200);
    assert_eq!(result.1["reactionMembers"]["👍"], json!([f.member]));
    assert_eq!(result.1["reactions"], json!(["👍"]));
    assert_eq!(
        f.request(
            "POST",
            &path,
            Some(json!({"emoji":"👍","active":false,"userId":f.member})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    assert_eq!(
        f.request(
            "POST",
            &path,
            Some(json!({"emoji":"👎","active":true})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    f.close().await;
}
