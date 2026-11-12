mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn export_reads_every_page_and_thread_and_only_public_attachment_fields() {
    let f = Fixture::new().await;
    let snapshot = f.bootstrap().await;
    let id = snapshot["conversations"][0]["id"].as_str().unwrap();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    sqlx::query("DELETE FROM messages")
        .execute(&store.pool)
        .await
        .unwrap();
    let mut tx = store.begin().await.unwrap();
    for i in 0..503 {
        openbot_backend::workspace::WorkspaceStore::put_in(
            &mut tx,
            Table::Messages,
            &json!({
                "id": format!("message-{i}"), "conversationId":id, "role":"user",
                "content": format!("Synthetic message {i}"), "createdAt":"2026-11-01T00:00:00Z",
                "threadRootId": if i == 502 { Some("message-0") } else { None },
                "metadata":{"author":{"name":"Synthetic author"},"token":"never-export-this"}
            }),
        )
        .await
        .unwrap();
    }
    openbot_backend::workspace::WorkspaceStore::put_in(&mut tx, Table::Messages, &json!({
        "id":"other-message", "conversationId":"other-chat", "role":"user", "content":"foreign-content"
    })).await.unwrap();
    openbot_backend::workspace::WorkspaceStore::put_in(
        &mut tx,
        Table::Files,
        &json!({
            "id":"file-a", "conversationId":id, "name":"private-storage/report.txt", "size":37,
            "source":{"path":"/private/secret"}, "url":"https://example.test/?token=secret"
        }),
    )
    .await
    .unwrap();
    openbot_backend::workspace::WorkspaceStore::put_in(&mut tx, Table::Messages, &json!({
        "id":"file-message", "conversationId":id, "role":"assistant", "kind":"file",
        "content":"private-storage/report.txt", "metadata":{"fileId":"file-a"}, "status":"running"
    })).await.unwrap();
    tx.commit().await.unwrap();
    let path = f.path(&format!("/conversations/{id}/export?language=en"));
    let (status, data) = f.request("GET", &path, None, true, Some(&f.member)).await;
    assert_eq!(status, 200, "{data}");
    assert_eq!(data["messageCount"], 504);
    assert_eq!(data["complete"], true);
    let content = data["content"].as_str().unwrap();
    for expected in [
        "Synthetic message 0",
        "Synthetic message 502",
        "Thread root: message-0",
        "Synthetic author",
        "Attachment: report.txt (37 bytes)",
        "Status: running",
    ] {
        assert!(content.contains(expected), "missing {expected}");
    }
    for secret in [
        "foreign-content",
        "never-export-this",
        "private-storage",
        "/private/secret",
        "token=secret",
    ] {
        assert!(!content.contains(secret), "leaked {secret}");
    }
    let (status, zh) = f
        .request(
            "GET",
            &path.replace("language=en", "language=zh-CN"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert!(
        zh["content"]
            .as_str()
            .unwrap()
            .contains("附件: report.txt (37 字节)")
    );
    let (status, _) = f.request("HEAD", &path, None, false, Some(&f.owner)).await;
    assert_eq!(status, 204);
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    for method in ["GET", "HEAD"] {
        assert_eq!(
            f.request(method, &path, None, true, Some(&f.member))
                .await
                .0,
            403
        );
    }
    f.close().await;
}

#[tokio::test]
async fn export_requires_account_and_matching_actor_before_store_access() {
    let f = Fixture::new().await;
    let snapshot = f.bootstrap().await;
    let id = snapshot["conversations"][0]["id"].as_str().unwrap();
    let path = f.path(&format!("/conversations/{id}/export"));
    assert_eq!(f.request("GET", &path, None, false, None).await.0, 403);
    assert_eq!(
        f.request("GET", &path, None, false, Some(&f.member))
            .await
            .0,
        403
    );
    let foreign = format!("/api/workspaces/{}/conversations/{id}/export", f.foreign);
    assert_eq!(
        f.request("GET", &foreign, None, false, Some(&f.owner))
            .await
            .0,
        403
    );
    assert!(!f.directory.path().join("spaces").join(&f.foreign).exists());
    assert_eq!(
        f.request(
            "GET",
            &f.path(&format!("/conversations/{}/export", uuid::Uuid::new_v4())),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        404
    );
    f.close().await;
}
