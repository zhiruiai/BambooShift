mod bot_templates_support;
use bot_templates_support::{Templates, id, webp};
use openbot_backend::workspace::Table;
use serde_json::json;

#[tokio::test]
async fn exact_copy_is_atomic_durable_and_omits_source_private_resources() {
    let t = Templates::new().await;
    let preview = t.source().await;
    assert_eq!(preview["blueprint"]["skills"].as_array().unwrap().len(), 1);
    assert!(!preview.to_string().contains("PRIVATE MEMORY"));
    let body = json!({"requestId":id(),"agentId":t.agent,"expectedSourceRevision":preview["sourceRevision"],"name":"Independent copy","routineMode":"preserve"});
    let (a, b) = tokio::join!(
        t.call("POST", "/bot-copies", Some(body.clone())),
        t.call("POST", "/bot-copies", Some(body.clone()))
    );
    assert!(a.0 == 201 || b.0 == 201, "{a:?} {b:?}");
    let (status, receipt) = t.call("POST", "/bot-copies", Some(body.clone())).await;
    assert_eq!(status, 201, "{receipt}");
    assert_eq!(t.store.list(Table::Agents).await.unwrap().len(), 2);
    let bot = t
        .store
        .get(Table::Agents, receipt["agentId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bot["name"], "Independent copy");
    assert!(bot.get("sharedBot").is_none());
    assert!(bot.get("avatarImageId").is_none());
    let skills = t.store.list(Table::Skills).await.unwrap();
    assert_eq!(
        skills.iter().filter(|s| s["agentId"] == bot["id"]).count(),
        1
    );
    let routines = t.store.list(Table::Routines).await.unwrap();
    let routine = routines.iter().find(|r| r["agentId"] == bot["id"]).unwrap();
    assert_eq!(routine["enabled"], true);
    assert_eq!(routine["timeZone"], "Asia/Shanghai");
    assert_eq!(routine["conversationId"], receipt["conversationId"]);
    assert_eq!(t.store.list(Table::Memories).await.unwrap().len(), 1);
    assert!(t.store.list(Table::Messages).await.unwrap().is_empty());
    assert!(t.store.list(Table::Files).await.unwrap().is_empty());
    t.store.delete(Table::Agents, &t.agent).await.unwrap();
    let (status, replayed) = t.call("POST", "/bot-copies", Some(body)).await;
    assert_eq!(status, 201);
    assert_eq!(receipt, replayed);
    let (status, get) = t
        .call(
            "GET",
            &format!("/bot-copies/{}", receipt["requestId"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(get, receipt);
    t.close().await;
}
#[tokio::test]
async fn copying_preserves_normalized_avatar_bytes_with_new_asset_id_and_real_decode() {
    let t = Templates::new().await;
    let asset = id();
    let bytes = webp();
    sqlx::query("INSERT INTO avatar_assets(id,data,bytes,published) VALUES(?,?,?,1)").bind(&asset).bind(json!({"id":asset,"width":512,"height":512,"mimeType":"image/webp","createdAt":"2026-11-01T00:00:00.000Z"}).to_string()).bind(&bytes).execute(&t.store.pool).await.unwrap();
    let mut bot = t.store.get(Table::Agents, &t.agent).await.unwrap().unwrap();
    bot["avatarImageId"] = json!(asset);
    t.store.put(Table::Agents, &bot).await.unwrap();
    let preview = t.source().await;
    let (status,receipt)=t.call("POST","/bot-copies",Some(json!({"requestId":id(),"agentId":t.agent,"expectedSourceRevision":preview["sourceRevision"],"name":"Avatar copy","routineMode":"pause"}))).await;
    assert_eq!(status, 201, "{receipt}");
    let copy = t
        .store
        .get(Table::Agents, receipt["agentId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(copy["avatarImageId"], asset);
    let result: Vec<u8> =
        sqlx::query_scalar("SELECT bytes FROM avatar_assets WHERE id=? AND published=1")
            .bind(copy["avatarImageId"].as_str())
            .fetch_one(&t.store.pool)
            .await
            .unwrap();
    assert_eq!(result, bytes);
    let routine = t
        .store
        .get(Table::Routines, receipt["routineIds"][0].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(routine["enabled"], false);
    t.close().await;
}
#[tokio::test]
async fn source_cas_invalid_input_and_receipt_failure_never_leave_partial_bot() {
    let t = Templates::new().await;
    let preview = t.source().await;
    let body = json!({"requestId":id(),"agentId":t.agent,"expectedSourceRevision":preview["sourceRevision"],"name":"Must rollback","routineMode":"pause"});
    sqlx::query("CREATE TRIGGER fail_install BEFORE INSERT ON bot_install_receipts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").execute(&t.store.pool).await.unwrap();
    let (status, _) = t.call("POST", "/bot-copies", Some(body.clone())).await;
    assert_eq!(status, 500);
    assert_eq!(t.store.list(Table::Agents).await.unwrap().len(), 1);
    assert_eq!(t.store.list(Table::Conversations).await.unwrap().len(), 1);
    assert_eq!(t.store.list(Table::Skills).await.unwrap().len(), 2);
    sqlx::query("DROP TRIGGER fail_install")
        .execute(&t.store.pool)
        .await
        .unwrap();
    let mut bot = t.store.get(Table::Agents, &t.agent).await.unwrap().unwrap();
    bot["instructions"] = json!("Changed after preview");
    t.store.put(Table::Agents, &bot).await.unwrap();
    let (status, error) = t.call("POST", "/bot-copies", Some(body)).await;
    assert_eq!(status, 409);
    assert_eq!(error["code"], "BOT_INSTALL_NOT_STARTED");
    bot["sharedBot"] = json!({"shareId":id()});
    t.store.put(Table::Agents, &bot).await.unwrap();
    let (status, _) = t
        .call("GET", &format!("/bot-copy-source/{}", t.agent), None)
        .await;
    assert_eq!(status, 403);
    assert_eq!(t.store.list(Table::Agents).await.unwrap().len(), 1);
    t.close().await;
}
#[tokio::test]
async fn copy_owner_session_and_fixed_account_cannot_be_replaced() {
    let t = Templates::new().await;
    let preview = t.source().await;
    let body = json!({"requestId":id(),"agentId":t.agent,"expectedSourceRevision":preview["sourceRevision"],"name":"Unauthorized","routineMode":"pause"});
    for (member, expected) in [
        (true, Some(t.f.member.as_str())),
        (true, Some(t.f.owner.as_str())),
        (false, None),
    ] {
        let (status, _) =
            t.f.request(
                "POST",
                &t.f.path("/bot-copies"),
                Some(body.clone()),
                member,
                expected,
            )
            .await;
        assert_eq!(status, 403);
    }
    assert_eq!(t.store.list(Table::Agents).await.unwrap().len(), 1);
    t.close().await;
}
