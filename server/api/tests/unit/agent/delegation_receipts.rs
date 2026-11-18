use super::*;
use crate::workspace::{Table, website_projects};

#[tokio::test]
async fn receipts_are_bounded_and_never_borrow_other_runs_or_missing_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let store = WorkspaceStore::open(directory.path()).await.unwrap();
    let mut tx = store.begin().await.unwrap();
    website_projects::initialize(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    for index in 0..18 {
        let mut message = json!({"id":format!("receipt-{index}"),"kind":"file",
                "role":"assistant","status":"done","conversationId":"chat","agentId":"child",
                "metadata":{"runId":"run","fileId":format!("file-{index}"),"name":format!("review-{index}.md"),
                    "size":1,"sha256":"synthetic-version","fileDelivery":{}}});
        match index {
            13 => message["metadata"]["runId"] = json!("previous-run"),
            14 => message["conversationId"] = json!("other-chat"),
            15 => message["agentId"] = json!("other-colleague"),
            16 => message["role"] = json!("user"),
            _ => {}
        }
        store.put(Table::Messages, &message).await.unwrap();
        if index != 17 {
            store
                .put(
                    Table::Files,
                    &json!({"id":format!("file-{index}"),
                    "source":{"kind":"workspace_delivery","sha256":"synthetic-version"}}),
                )
                .await
                .unwrap();
        }
    }
    let result = collect(&store, "run", "chat", "child").await.unwrap();
    let items = result["items"].as_array().unwrap();
    assert_eq!(items.len(), MAX_RECEIPTS);
    assert_eq!(result["truncated"], true);
    assert_eq!(items.first().unwrap()["messageId"], "receipt-1");
    assert_eq!(items.last().unwrap()["messageId"], "receipt-12");
    store.delete(Table::Files, "file-12").await.unwrap();
    let result = collect(&store, "run", "chat", "child").await.unwrap();
    assert_eq!(result["truncated"], false);
    assert_eq!(result["items"][0]["messageId"], "receipt-0");
    assert_eq!(result["items"][11]["messageId"], "receipt-11");
    assert!(
        collect(&store, "new-run", "chat", "child").await.unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    store.pool.close().await;
}
