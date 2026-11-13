use crate::{
    error::{ApiError, Result},
    workspace::WorkspaceStore,
};
use serde_json::{Value, json};

const MAX_RECEIPTS: usize = 12;

/// Return only server-published artifacts from this exact child, never claims in its prose.
pub(crate) async fn collect(
    store: &WorkspaceStore,
    run_id: &str,
    conversation_id: &str,
    agent_id: &str,
) -> Result<Value> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT m.data FROM messages m
         WHERE json_extract(m.data,'$.role')='assistant'
           AND json_extract(m.data,'$.status')='done'
           AND json_extract(m.data,'$.metadata.runId')=?
           AND json_extract(m.data,'$.conversationId')=?
           AND json_extract(m.data,'$.agentId')=?
           AND (
             (json_extract(m.data,'$.kind')='file'
              AND json_type(m.data,'$.metadata.fileDelivery')='object'
              AND EXISTS (
                SELECT 1 FROM files f
                WHERE f.id=json_extract(m.data,'$.metadata.fileId')
                  AND json_extract(f.data,'$.source.kind')='workspace_delivery'
                  AND json_extract(f.data,'$.source.sha256')=
                      json_extract(m.data,'$.metadata.sha256')
              ))
             OR
             (json_extract(m.data,'$.kind')='website_project'
              AND EXISTS (
                SELECT 1 FROM website_projects p
                WHERE p.id=json_extract(m.data,'$.metadata.websiteProject.id')
              ))
           )
         ORDER BY m.rowid DESC LIMIT ?",
    )
    .bind(run_id)
    .bind(conversation_id)
    .bind(agent_id)
    .bind((MAX_RECEIPTS + 1) as i64)
    .fetch_all(&store.pool)
    .await?;
    let truncated = rows.len() > MAX_RECEIPTS;
    let mut receipts = Vec::new();
    for raw in rows.into_iter().take(MAX_RECEIPTS) {
        let message: Value = serde_json::from_str(&raw)
            .map_err(|_| ApiError::new(500, "同事的交付记录暂不可用。"))?;
        let metadata = &message["metadata"];
        let receipt = if message["kind"] == "file" {
            json!({"kind":"file","messageId":message["id"],"fileId":metadata["fileId"],
                "name":metadata["name"],"size":metadata["size"],"sha256":metadata["sha256"]})
        } else {
            json!({"kind":"website_project","messageId":message["id"],
                "project":metadata["websiteProject"],"directory":metadata["websiteProjectDirectory"]})
        };
        receipts.push(receipt);
    }
    receipts.reverse();
    Ok(json!({"items":receipts,"truncated":truncated,"scope":"direct_child_run"}))
}

#[cfg(test)]
mod tests {
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
}
