use super::{
    authority::ExecutionAccess,
    registry::{ActiveRun, AgentRegistry},
    run_context::direct,
    tools::{ToolContext, check_fence},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{
        Table, WorkspaceAccess, WorkspaceStore,
        creation_preview::{self, Kind, THEME_BACKDROPS, THEME_BADGES, THEME_MOTIFS},
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(crate) fn kind(name: &str) -> Option<Kind> {
    match name {
        "propose_bot" => Some(Kind::Bot),
        "propose_avatar_theme" => Some(Kind::Theme),
        _ => None,
    }
}

pub(crate) fn definitions() -> [Value; 2] {
    let color = json!({"type":"string","pattern":"^#[0-9a-fA-F]{6}$"});
    let bot = json!({
        "name":"propose_bot",
        "description":"Draft a focused new Bot profile for the requesting owner to review. Use their language. Keep profile text plain and give the Bot concrete work instructions within existing permissions. This only posts a review card.",
        "parameters":{"type":"object","additionalProperties":false,
            "properties":{
                "name":{"type":"string","minLength":1,"maxLength":40},
                "role":{"type":"string","minLength":1,"maxLength":80},
                "description":{"type":"string","maxLength":1000},
                "instructions":{"type":"string","maxLength":16000},
                "avatar":{"type":"string","enum":["orb","drop","leaf","spark","gem","arch"]},
                "color":color
            },"required":["name","role","description","instructions","avatar","color"]
        }
    });
    let theme = json!({
        "name":"propose_avatar_theme",
        "description":"Draft an avatar theme for the requesting owner to review. Use a name in their language made of letters, numbers, spaces, hyphens, apostrophes, or middle dots. Pick three distinct colors. This only posts a review card.",
        "parameters":{"type":"object","additionalProperties":false,
            "properties":{
                "name":{"type":"string","minLength":1,"maxLength":40},
                "motif":{"type":"string","enum":THEME_MOTIFS},
                "colors":{"type":"array","minItems":3,"maxItems":3,"uniqueItems":true,"items":color},
                "badge":{"type":"string","enum":THEME_BADGES},
                "backdrop":{"type":"string","enum":THEME_BACKDROPS}
            },"required":["name","motif","colors","badge","backdrop"]
        }
    });
    [bot, theme]
}

fn root_owner<'a>(access: &'a ExecutionAccess, active: &ActiveRun) -> Option<&'a WorkspaceAccess> {
    match access {
        ExecutionAccess::User(actor)
            if actor.is_owner
                && active.kind == "user"
                && active.depth == 0
                && !active.background
                && active.run_id == active.root_run_id
                && active.user_id == actor.user_id =>
        {
            Some(actor)
        }
        _ => None,
    }
}

pub(crate) async fn may_offer(
    state: &State,
    access: &ExecutionAccess,
    active: &ActiveRun,
    conversation: &Value,
) -> bool {
    let Some(actor) = root_owner(access, active) else {
        return false;
    };
    direct(conversation, &active.agent_id) && actor.authorize_owner(state).await.is_ok()
}

fn forbidden() -> ApiError {
    ApiError::new(403, "只有工作空间拥有者在本地 Bot 私聊中可以提出创建草稿。")
        .with_code("CREATION_PREVIEW_FORBIDDEN")
}

async fn authorize(
    state: &State,
    access: &ExecutionAccess,
    context: &ToolContext<'_>,
) -> Result<()> {
    let active = context.active;
    let actor = root_owner(access, active).ok_or_else(forbidden)?;
    check_fence(active, context.generation)?;
    actor.authorize_owner(state).await?;
    active.family.authorize(state).await?;
    let key = AgentRegistry::key(&actor.workspace_id, &active.conversation_id);
    if !state
        .agent_runs
        .get(&key)
        .await
        .is_some_and(|registered| Arc::ptr_eq(&registered, active))
    {
        return Err(forbidden());
    }
    check_fence(active, context.generation)
}

pub(crate) async fn execute(
    state: &State,
    access: &ExecutionAccess,
    store: &WorkspaceStore,
    context: &ToolContext<'_>,
    kind: Kind,
    args: &Value,
) -> Result<Value> {
    authorize(state, access, context).await?;
    let active = context.active;
    let name_field = match kind {
        Kind::Bot => "profile",
        Kind::Theme => "theme",
    };
    let preview = creation_preview::validate(kind, args)?;
    let mut tx = store.begin().await?;
    let mut chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, &active.conversation_id)
        .await?
        .filter(|chat| direct(chat, &active.agent_id))
        .ok_or_else(forbidden)?;
    if !WorkspaceStore::get_in(&mut tx, Table::Agents, &active.agent_id)
        .await?
        .is_some_and(|agent| agent.get("sharedBot").is_none())
    {
        return Err(forbidden());
    }
    let input = WorkspaceStore::get_in(&mut tx, Table::Messages, &active.requester_message_id)
        .await?
        .ok_or_else(forbidden)?;
    if input["role"] != "user"
        || input["userId"] != access.user_id()
        || input["conversationId"] != active.conversation_id
        || input["delivery"]["agentId"] != active.agent_id
        || input["delivery"]["runId"] != active.root_run_id
        || input["delivery"]["state"] != "delivered"
        || [
            "routineRun",
            "routineOperation",
            "memoryImport",
            "primaryCheckIn",
        ]
        .iter()
        .any(|key| input["metadata"].get(key).is_some())
    {
        return Err(forbidden());
    }

    let digest = Sha256::digest(json!([active.root_run_id, access.user_id(), preview]).to_string());
    let id = format!("creation-preview-{}", hex::encode(digest));
    let existing = WorkspaceStore::get_in(&mut tx, Table::Messages, &id).await?;
    let mut created = None;
    if let Some(prior) = existing {
        if prior["kind"] != "creation_preview"
            || prior["conversationId"] != active.conversation_id
            || prior["agentId"] != active.agent_id
            || prior["metadata"]["runId"] != active.root_run_id
            || prior["metadata"]["inputMessageId"] != active.requester_message_id
            || prior["metadata"]["requesterUserId"] != access.user_id()
            || prior["metadata"]["creationPreview"] != preview
        {
            return Err(ApiError::new(409, "创建草稿记录不匹配。"));
        }
    } else {
        let stamp = iso(now());
        let mut message = json!({
            "id":id,"conversationId":active.conversation_id,"agentId":active.agent_id,
            "role":"assistant","kind":"creation_preview","content":preview[name_field]["name"],
            "status":"done","createdAt":stamp,"metadata":{
                "creationPreview":preview,"runId":active.root_run_id,
                "inputMessageId":active.requester_message_id,"requesterUserId":access.user_id()
            }
        });
        super::threads::stamp(&mut message, active.thread_root_id.as_deref());
        WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        chat["updatedAt"] = json!(stamp);
        WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
        created = Some(message);
    }
    authorize(state, access, context).await?;
    tx.commit().await?;
    if let Some(message) = created {
        store.emit("message", message);
        store.emit("update", json!({}));
    }
    let result = json!({"status":"draft","kind":preview["kind"],"messageId":id,"requiresOwnerConfirmation":true});
    Ok(json!({"content":[{"type":"text","text":result.to_string()}],"details":result}))
}
