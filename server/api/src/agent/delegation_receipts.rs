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
#[path = "../../tests/unit/agent/delegation_receipts.rs"]
mod tests;
