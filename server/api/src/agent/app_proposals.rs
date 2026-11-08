use super::{
    authority::ExecutionAccess,
    registry::ActiveRun,
    tools::{ToolContext, check_fence},
};
use crate::{
    apps::{connections, provider_catalog},
    db::{State, iso, now},
    error::{ApiError, Result, only_fields, text},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) const LOOKUP: &str = "list_app_providers";
pub(super) const SUGGEST: &str = "suggest_app_connection";
const MAX_QUERY: usize = 120;
const MAX_PROVIDERS: usize = 20;

fn local_chat(access: &ExecutionAccess, active: &ActiveRun) -> bool {
    active.kind == "user"
        && active.depth == 0
        && !active.background
        && active.family.app_context.get().is_none()
        && matches!(access, ExecutionAccess::User(_))
}
fn owner_chat(access: &ExecutionAccess, active: &ActiveRun) -> bool {
    local_chat(access, active) && access.as_user().is_some_and(|actor| actor.is_owner)
}
fn definition() -> Value {
    let ids: Vec<&str> = provider_catalog::entries()
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    json!({"name":SUGGEST,"description":"Suggest one provider from list_app_providers when the human needs to connect it. Creates a review card only. The owner must review the existing connection form and complete any required authorization.","parameters":{"type":"object","additionalProperties":false,"properties":{"providerId":{"type":"string","enum":ids},"reason":{"type":"string","minLength":1,"maxLength":300}},"required":["providerId","reason"]}})
}

pub(super) fn offer(
    access: &ExecutionAccess,
    active: &ActiveRun,
    definitions: &mut Vec<Value>,
    system: &mut String,
) {
    if local_chat(access, active) {
        definitions.push(json!({"name":LOOKUP,"description":"Find official app providers and their current connection status in this workspace. Use a provider name, product keyword, or category; omit query to see the directory. Use list_apps to discover the tools of existing connections.","parameters":{"type":"object","additionalProperties":false,"properties":{"query":{"type":"string","maxLength":MAX_QUERY}}}}));
        system.push_str("\nWhen an app is needed, use list_app_providers to identify an official provider and check its connection status. For a connected app, discover its existing tools and follow the app approval flow.");
    }
    if owner_chat(access, active) {
        definitions.push(definition());
        system.push_str("\nWhen the human needs an app connected or reauthorized, use suggest_app_connection with the official provider ID and a brief reason in the human's language. The card only opens the existing setup flow for owner review. Do not ask for access tokens, passwords or OAuth secrets in chat, and only report a connection as active when its status confirms it.");
    }
}

pub(super) async fn lookup(
    state: &State,
    access: &ExecutionAccess,
    store: &WorkspaceStore,
    context: &ToolContext<'_>,
    args: &Value,
) -> Result<Value> {
    if !local_chat(access, context.active) {
        return Err(ApiError::new(403, "此任务未授予应用目录查询。"));
    }
    only_fields(args, &["query"])?;
    let query = args
        .get("query")
        .map_or(Some(""), Value::as_str)
        .filter(|query| {
            query.encode_utf16().count() <= MAX_QUERY && !query.chars().any(char::is_control)
        })
        .ok_or_else(|| ApiError::bad("应用目录查询无效。"))?
        .trim()
        .to_lowercase();
    let connections = connections::list(store).await?;
    let mut providers = provider_catalog::entries()
        .iter()
        .filter(|provider| provider.matches(&query));
    let matches = providers.by_ref().take(MAX_PROVIDERS).map(|provider| {
        let matches_endpoint = |connection: &&Value| {
            connection["url"].as_str().is_some_and(|url| provider.matches_endpoint(url))
        };
        let existing = connections.iter().filter(matches_endpoint)
            .find(|connection| connection["status"] == "connected")
            .or_else(|| connections.iter().find(matches_endpoint));
        let mut entry = json!({"providerId":provider.id,"name":provider.name,"category":provider.category,"authType":provider.auth_type,"connectionStatus":"not_connected"});
        if let Some(connection) = existing {
            entry["connectionId"] = connection["id"].clone();
            entry["connectionStatus"] = connection["status"].clone();
        }
        entry
    }).collect::<Vec<_>>();
    access.authorize(state).await?;
    super::tools::authorize_membership(store, context.active).await?;
    check_fence(context.active, context.generation)?;
    let result = json!({"providers":matches,"hasMore":providers.next().is_some()});
    Ok(json!({"content":[{"type":"text","text":result.to_string()}],"details":result}))
}
async fn authorize(
    state: &State,
    access: &ExecutionAccess,
    context: &ToolContext<'_>,
) -> Result<()> {
    let active = context.active;
    if !owner_chat(access, active) {
        return Err(
            ApiError::new(403, "只有拥有者当前发起的本地 Bot 聊天可以建议连接应用。")
                .with_code("APP_PROPOSAL_FORBIDDEN"),
        );
    }
    check_fence(active, context.generation)?;
    access.authorize_owner(state).await?;
    active.family.authorize(state).await?;
    check_fence(active, context.generation)
}
pub(crate) async fn execute(
    state: &State,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    context: &ToolContext<'_>,
    args: &Value,
) -> Result<Value> {
    authorize(state, access, context).await?;
    only_fields(args, &["providerId", "reason"])?;
    let provider = args["providerId"]
        .as_str()
        .filter(|id| {
            provider_catalog::entries()
                .iter()
                .any(|entry| entry.id == *id)
        })
        .ok_or_else(|| ApiError::bad("请选择目录中的应用。"))?;
    let reason = text(&args["reason"], "建议原因", 300)?;
    if reason.encode_utf16().count() > 300 || reason.contains('\0') {
        return Err(ApiError::bad("建议原因过长或无效。"));
    }
    publish(
        state,
        access,
        store,
        context,
        json!({"providerId":provider,"reason":reason}),
        provider,
    )
    .await
}
pub(super) async fn publish(
    state: &State,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    context: &ToolContext<'_>,
    proposal: Value,
    identity: &str,
) -> Result<Value> {
    authorize(state, access, context).await?;
    let custom = proposal["kind"] == "custom_mcp";
    if custom {
        super::custom_app_proposals::authorize(state, access, context).await?;
    }
    let active = context.active;
    let id = format!(
        "app-proposal-{}",
        hex::encode(Sha256::digest(format!("{}:{identity}", active.root_run_id)))
    );
    let mut tx = store.begin().await?;
    let bot = WorkspaceStore::get_in(&mut tx, Table::Agents, &active.agent_id)
        .await?
        .filter(|bot| bot.get("sharedBot").is_none())
        .ok_or_else(|| ApiError::new(403, "负责的本地 Bot 已不可用。"))?;
    let mut chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, &active.conversation_id)
        .await?
        .filter(|chat| {
            chat["agentIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(&bot["id"]))
        })
        .ok_or_else(|| ApiError::new(403, "负责的 Bot 已离开当前会话。"))?;
    let input = WorkspaceStore::get_in(&mut tx, Table::Messages, &active.requester_message_id)
        .await?
        .ok_or_else(|| ApiError::new(403, "原人工消息已不存在。"))?;
    if input["role"] != "user"
        || input["userId"] != access.user_id()
        || input["conversationId"] != active.conversation_id
        || !super::threads::belongs(&input, active.thread_root_id.as_deref())
        || !super::mentions::delivered_to(&input, &active.agent_id, &active.root_run_id)
        || ["routineRun", "routineOperation", "memoryImport"]
            .iter()
            .any(|key| input["metadata"].get(key).is_some())
    {
        return Err(ApiError::new(403, "原人工消息的授权已失效。"));
    }
    if custom {
        super::custom_app_proposals::validate_source(state, active, &chat, &input, &proposal)?;
    }
    let prior = WorkspaceStore::get_in(&mut tx, Table::Messages, &id).await?;
    let mut created = false;
    let message = if let Some(prior) = prior {
        if prior["kind"] != "app_connection_proposal"
            || prior["conversationId"] != active.conversation_id
            || prior["agentId"] != active.agent_id
            || !super::threads::belongs(&prior, active.thread_root_id.as_deref())
            || ["providerId", "kind", "url", "name"]
                .iter()
                .any(|key| prior["metadata"]["appConnectionProposal"][key] != proposal[key])
            || prior["metadata"]["appConnectionProposal"]["requester"]["userId"] != access.user_id()
            || prior["metadata"]["appConnectionProposal"]["requester"]["messageId"]
                != active.requester_message_id
        {
            return Err(ApiError::new(409, "应用建议记录不匹配。"));
        }
        prior
    } else {
        let stamp = iso(now());
        let mut metadata = proposal.clone();
        metadata["runId"] = json!(active.root_run_id);
        metadata["toolCallId"] = json!(context.call_id);
        metadata["requester"] =
            json!({"userId":access.user_id(),"messageId":active.requester_message_id});
        let mut message = json!({"id":id,"conversationId":active.conversation_id,"agentId":active.agent_id,"role":"assistant","kind":"app_connection_proposal","content":proposal["reason"],"status":"done","createdAt":stamp,"metadata":{"appConnectionProposal":metadata}});
        super::threads::stamp(&mut message, active.thread_root_id.as_deref());
        WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        chat["updatedAt"] = json!(stamp);
        WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
        created = true;
        message
    };
    authorize(state, access, context).await?;
    if custom {
        super::custom_app_proposals::authorize(state, access, context).await?;
    }
    tx.commit().await?;
    if created {
        store.emit("message", message.clone());
        store.emit("update", json!({}));
    }
    let mut result =
        json!({"status":"suggested","messageId":message["id"],"requiresOwnerConfirmation":true});
    for key in ["providerId", "kind", "url", "name"] {
        if let Some(value) = proposal.get(key) {
            result[key] = value.clone();
        }
    }
    Ok(json!({"content":[{"type":"text","text":result.to_string()}],"details":result}))
}
