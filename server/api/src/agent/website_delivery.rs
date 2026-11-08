use super::{apps_tools::authority, authority::ExecutionAccess, tools::ToolContext};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{
        Table, WorkspaceStore,
        website_projects::{self, MAX_FILES, MAX_PATH, MAX_TITLE, Publication},
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc};

pub(crate) const TOOL: &str = "workspace_deliver_website";

pub(crate) fn definition() -> Value {
    let path = json!({"type":"string","minLength":1,"maxLength":MAX_PATH});
    json!({
        "name":TOOL,
        "description":"Deliver a completed static website as a private project card with a ZIP and isolated preview. Keep all project files in one workspace directory. Provide the exact relative asset paths and SHA-256 values from workspace_write or workspace_read with digestOnly=true, including the HTML entry. Bundle all runtime dependencies in the directory. The delivery does not download externals or deploy a website. Editing source files never changes earlier versions.",
        "parameters":{"type":"object","additionalProperties":false,"required":["directory","title","entry","files"],"properties":{
            "directory":path,"title":{"type":"string","minLength":1,"maxLength":MAX_TITLE},"entry":path,
            "files":{"type":"array","minItems":1,"maxItems":MAX_FILES,"items":{"type":"object","additionalProperties":false,"required":["path","sha256"],"properties":{"path":path,"sha256":{"type":"string","pattern":"^[a-fA-F0-9]{64}$"}}}}
        }}
    })
}

pub(crate) async fn deliver(
    state: &State,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    context: &ToolContext<'_>,
    args: &Value,
) -> Result<Value> {
    let authorize = authority(state, access, store, context);
    authorize().await?;
    let input = Publication::parse(args)?;
    let active = context.active;
    let mut tx = store.begin().await?;
    let summary = website_projects::snapshot(
        &mut tx,
        store,
        access.storage_key(),
        access.user_id(),
        &input,
    )
    .await?;
    let message_id = format!(
        "website-delivery-{}",
        hex::encode(Sha256::digest(
            json!([active.run_id, summary.id]).to_string()
        ))
    );
    let summary =
        serde_json::to_value(summary).map_err(|_| ApiError::new(500, "网站交付记录无效。"))?;
    let mut created = None;
    if let Some(existing) = WorkspaceStore::get_in(&mut tx, Table::Messages, &message_id).await? {
        if existing["kind"] != "website_project"
            || existing["conversationId"] != active.conversation_id
            || existing["agentId"] != active.agent_id
            || existing["metadata"]["websiteProject"] != summary
        {
            return Err(ApiError::new(409, "网站交付记录不匹配。"));
        }
    } else {
        let stamp = iso(now());
        let mut message = json!({"id":message_id,"conversationId":active.conversation_id,"agentId":active.agent_id,
            "role":"assistant","kind":"website_project","status":"done","content":summary["title"],"createdAt":stamp,
            "metadata":{"websiteProject":summary,"websiteProjectDirectory":input.directory,"runId":active.run_id,
                "inputMessageId":context.input["id"],"toolCallId":context.call_id}});
        super::threads::stamp(&mut message, active.thread_root_id.as_deref());
        WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        created = Some(message);
    }
    authorize().await?;
    tx.commit().await?;
    if let Some(message) = created {
        store.emit("message", message);
        store.emit("update", json!({}));
    }
    let value = json!({"delivered":true,"messageId":message_id,"project":summary,"directory":input.directory});
    Ok(json!({"content":[{"type":"text","text":value.to_string()}],"details":value}))
}

pub(crate) fn recent_projects(history: &[Value], origin: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    history.iter().rev().chain(origin).filter_map(|message| {
        if message["role"] != "assistant" || message["kind"] != "website_project" { return None; }
        let project = &message["metadata"]["websiteProject"];
        let key = project["projectKey"].as_str()?;
        let directory = message["metadata"]["websiteProjectDirectory"].as_str()?;
        if !seen.insert(key) { return None; }
        Some(json!({"id":project["id"],"projectKey":key,"title":project["title"],"entry":project["entry"],"directory":directory}))
    }).take(4).collect()
}
