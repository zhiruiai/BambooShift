use super::{app_proposals, authority::ExecutionAccess, registry::ActiveRun};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, text},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use uuid::Uuid;

pub(crate) fn definitions() -> Value {
    let mut definitions = json!([
        {"name":"delegate","description":"Ask an eligible colleague from list_peers for a focused subtask and wait for its real result. A completed status means the run finished, not that its output passed acceptance. Review deliveries.items for server-published file/website receipts from that exact child run; text-only claims are not delivery or test evidence. Read the referenced artifacts and verify acceptance before reporting project completion. Workgroups are limited to existing members. In a personal primary Bot's human-requested DM, eligible local colleagues work in their own existing DMs. Never creates members or grants extra permissions.","parameters":{"type":"object","properties":{"agentId":{"type":"string"},"task":{"type":"string"}},"required":["agentId","task"]}},
        {"name":"propose_team","description":"Propose a team draft for human review. Never creates Bots or starts work automatically. Requires a title, member assignments and lead member in a structured draft.","parameters":{"type":"object","properties":{"goal":{"type":"string"},"draft":{"type":"object"}},"required":["goal","draft"]}},
        {"name":"remember","description":"Save explicitly relevant long-term context for this Bot. Does not change permissions.","parameters":{"type":"object","properties":{"content":{"type":"string"},"category":{"type":"string","enum":["preference","context","learning"]}},"required":["content"]}},
        {"name":"list_peers","description":"Read eligible colleagues for this task. Groups retain current members; a personal primary Bot's direct human task can list local colleagues with their own DMs. Availability is rechecked on delegation.","parameters":{"type":"object","properties":{}}},
        {"name":"propose_skill","description":"Save a proposed reusable method for the human owner to review. It is not enabled automatically.","parameters":{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"content":{"type":"string"}},"required":["name","content"]}}
    ]);
    let all = definitions.as_array_mut().unwrap();
    all.push(super::run_knowledge::recall_definition());
    all.extend(super::apps_tools::definitions());
    all.extend(super::computer_tools::definitions());
    all.extend(super::routine_definitions::definitions());
    all.extend(super::workspace_tools::definitions());
    definitions
}
pub(super) fn definitions_for(
    access: &ExecutionAccess,
    active: &ActiveRun,
    system: &mut String,
) -> Value {
    let mut definitions = match active.kind {
        "primary_checkin" | "webhook" => {
            if knowledge_read_allowed(active, "recall") {
                json!([super::run_knowledge::recall_definition()])
            } else {
                json!([])
            }
        }
        "memory_import" => json!([
            super::import_memory::definition(),
            super::run_knowledge::recall_definition()
        ]),
        _ => {
            let mut tools = definitions();
            app_proposals::offer(access, active, tools.as_array_mut().unwrap(), system);
            super::questions::offer(access, active, tools.as_array_mut().unwrap(), system);
            tools
        }
    };
    if knowledge_read_allowed(active, "read_skill") {
        definitions
            .as_array_mut()
            .unwrap()
            .extend(super::run_knowledge::skill_definitions());
    }
    definitions
}
fn knowledge_read_allowed(active: &ActiveRun, name: &str) -> bool {
    let Some(knowledge) = active.family.knowledge(&active.run_id) else {
        return false;
    };
    match name {
        "list_skills" | "read_skill" => active.kind != "memory_import" && knowledge.lazy_skills,
        "recall" => {
            active.kind != "webhook"
                && (active.kind != "primary_checkin" || knowledge.lazy_memories)
        }
        _ => false,
    }
}
pub(super) fn restricted_tool_allowed(active: &ActiveRun, name: &str) -> bool {
    match active.kind {
        "primary_checkin" | "webhook" => knowledge_read_allowed(active, name),
        "memory_import" => matches!(name, "remember" | "recall"),
        _ => true,
    }
}
pub(super) fn filter_runtime_capabilities(
    grant: &ExecutionAccess,
    active: &ActiveRun,
    profile: &Value,
    definitions: &mut Value,
) {
    if profile["vision"] != true {
        definitions
            .as_array_mut()
            .unwrap()
            .retain(|tool| tool["name"] != "computer_observe");
    }
    if active.kind != "user"
        || active.depth != 0
        || !grant.as_user().is_some_and(|actor| actor.is_owner)
    {
        definitions.as_array_mut().unwrap().retain(|tool| {
            !tool["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("routine_"))
        });
    }
    if grant.shared().is_none() {
        definitions.as_array_mut().unwrap().retain(|tool| {
            !tool["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("shared_") || name == "read_shared_file")
        });
    }
}
pub(crate) struct ToolContext<'a> {
    pub active: &'a Arc<ActiveRun>,
    pub input: &'a Value,
    pub catalog: &'a [Value],
    pub generation: u64,
    pub call_id: &'a str,
}
pub(crate) fn check_fence(active: &ActiveRun, generation: u64) -> Result<()> {
    if active.cancelled.load(Ordering::Acquire)
        || active.finished.load(Ordering::Acquire)
        || active.generation.load(Ordering::Acquire) != generation
        || (active.depth > 0
            && active.admitted_generation != active.generation.load(Ordering::Acquire))
    {
        Err(ApiError::new(
            409,
            "原任务已停止或收到新要求，此次操作已取消。",
        ))
    } else {
        active.family.deadline.remaining_ms().map(|_| ())
    }
}
pub(crate) async fn authorize_membership(store: &WorkspaceStore, active: &ActiveRun) -> Result<()> {
    let conversation = store
        .get(Table::Conversations, &active.conversation_id)
        .await?;
    if !conversation.as_ref().is_some_and(|chat| {
        chat["agentIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == &active.agent_id))
    }) || store.get(Table::Agents, &active.agent_id).await?.is_none()
    {
        return Err(ApiError::new(
            409,
            "负责的 Bot 已离开当前会话，任务已取消。",
        ));
    }
    Ok(())
}
pub(crate) async fn execute(
    state: &State,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    context: &ToolContext<'_>,
    name: &str,
    args: &Value,
) -> Result<Value> {
    if !restricted_tool_allowed(context.active, name) {
        return Err(ApiError::new(403, "此任务未授予该工具。"));
    }
    if matches!(name, super::web_tools::SEARCH | super::web_tools::FETCH) {
        return super::web_tools::execute(state, access, store, context, name, args).await;
    }
    let active = context.active;
    let agent_id = active.agent_id.as_str();
    let conversation_id = active.conversation_id.as_str();
    let generation = context.generation;
    check_fence(active, generation)?;
    access.authorize(state).await?;
    active.family.authorize(state).await?;
    authorize_membership(store, active).await?;
    if matches!(name, "list_skills" | "read_skill" | "recall") {
        if !knowledge_read_allowed(active, name) {
            return Err(ApiError::new(403, "此任务未授予该知识读取工具。"));
        }
        let knowledge = active.family.knowledge(&active.run_id).unwrap();
        let output = match name {
            "list_skills" => super::run_knowledge::list_skills(&knowledge.skills, args)?,
            "read_skill" => super::run_knowledge::read_skill(&knowledge.skills, args)?,
            _ => {
                let memories = if active.kind == "primary_checkin" {
                    knowledge.checkin_memories.clone()
                } else {
                    store.agent_knowledge(Table::Memories, agent_id).await?
                };
                super::run_knowledge::recall(&memories, args)?
            }
        };
        access.authorize(state).await?;
        active.family.authorize(state).await?;
        authorize_membership(store, active).await?;
        check_fence(active, generation)?;
        return Ok(json!({"content":[{"type":"text","text":output.to_string()}],"details":output}));
    }
    if name == super::custom_app_proposals::TOOL {
        return super::custom_app_proposals::execute(state, access, store, context, args).await;
    }
    if name == super::questions::TOOL {
        return super::questions::execute(state, access, store, context, args).await;
    }
    if name == app_proposals::LOOKUP {
        return app_proposals::lookup(state, access, store, context, args).await;
    }
    if name == app_proposals::SUGGEST {
        return app_proposals::execute(state, access, store, context, args).await;
    }
    if name == super::voice_memo::TOOL {
        return super::voice_memo::execute(state, access, store, context, args).await;
    }
    if let Some(kind) = super::creation_proposals::kind(name) {
        return super::creation_proposals::execute(state, access, store, context, kind, args).await;
    }
    if name == "delegate" {
        return super::delegation::delegate(state, access, store, context, args).await;
    }
    if name == "propose_team" {
        let Some(grant) = access.as_user() else {
            return Err(ApiError::new(403, "后台任务不能提出人工团队方案。"));
        };
        if active.kind != "user" {
            return Err(ApiError::new(403, "此任务不能提出团队方案。"));
        }
        let guard = (*active).clone();
        let proposal = crate::team_builder::ProposalContext {
            conversation_id: conversation_id.to_owned(),
            thread_root_id: active.thread_root_id.clone(),
            agent_id: agent_id.to_owned(),
            input_message_id: context.input["id"].as_str().unwrap_or("").to_owned(),
            root_run_id: active.run_id.clone(),
            tool_call_id: context.call_id.to_owned(),
            agent_snapshot: context.catalog.to_vec(),
            authorize: Arc::new(move || check_fence(&guard, generation)),
        };
        let value = crate::team_builder::propose(state, grant, &proposal, args).await?;
        return Ok(json!({"content":[{"type":"text","text":value.to_string()}],"details":value}));
    }
    if active.kind == "memory_import" && name == "remember" {
        return super::import_memory::remember(state, access, store, active, generation, args)
            .await;
    }
    if name.starts_with("computer_") {
        return super::computer_tools::execute(state, access, store, context, name, args).await;
    }
    if name.starts_with("routine_") {
        return super::routine_tools::execute(state, access, store, context, name, args).await;
    }
    if name.starts_with("workspace_") {
        return super::workspace_tools::execute(state, access, store, context, name, args).await;
    }
    if [
        "list_apps",
        "list_app_tools",
        "app_action",
        "read_shared_file",
        "app_list",
        "app_tools",
        "app_call",
        "shared_app_list",
        "shared_app_tools",
        "shared_app_call",
        "shared_file_list",
        "shared_file_read",
    ]
    .contains(&name)
    {
        return super::apps_tools::execute(state, access, store, context, name, args).await;
    }
    let mut tx = store.begin().await?;
    let agent = WorkspaceStore::get_in(&mut tx, Table::Agents, agent_id)
        .await?
        .ok_or_else(|| ApiError::new(409, "负责的 Bot 已不存在。"))?;
    if agent.get("sharedBot").is_some() && access.shared().is_none() {
        return Err(ApiError::new(403, "共享 Bot 需要有效的来源授权。"));
    }
    let conversation = WorkspaceStore::get_in(&mut tx, Table::Conversations, conversation_id)
        .await?
        .ok_or_else(|| ApiError::new(409, "原会话已不存在。"))?;
    if !conversation["agentIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == agent_id))
    {
        return Err(ApiError::new(409, "负责的 Bot 已离开当前会话。"));
    }
    let output = match name {
        "remember" => {
            let content = text(&args["content"], "记忆", 6000)?;
            let category = args["category"].as_str().unwrap_or("context");
            if !["preference", "context", "learning"].contains(&category) {
                return Err(ApiError::bad("记忆分类无效。"));
            }
            let memory = json!({"id":Uuid::new_v4().to_string(),"agentId":agent_id,"content":content,"category":category,"createdAt":iso(now())});
            WorkspaceStore::put_in(&mut tx, Table::Memories, &memory).await?;
            memory
        }
        "list_peers" => {
            let catalog = WorkspaceStore::list_in(&mut tx, Table::Agents).await?;
            let snapshot = active
                .family
                .snapshot(conversation_id)
                .unwrap_or(conversation.clone());
            let peers =
                super::run_context::peers(state, access, store, active, &snapshot, &catalog)
                    .await?
                    .into_iter()
                    .filter(|bot| {
                        snapshot["isGroup"] != true
                            || conversation["agentIds"]
                                .as_array()
                                .is_some_and(|ids| ids.contains(&bot["id"]))
                    })
                    .collect::<Vec<_>>();
            json!({"peers":peers})
        }
        "propose_skill" => {
            if access.shared().is_some() {
                return Err(ApiError::new(403, "共享 Bot 的技能由来源拥有者维护。"));
            }
            let title = text(&args["name"], "技能名称", 100)?;
            let content = text(&args["content"], "技能内容", 16000)?;
            let version = WorkspaceStore::list_in(&mut tx, Table::Skills)
                .await?
                .iter()
                .filter(|s| s["agentId"] == agent_id && s["name"] == title)
                .filter_map(|s| s["version"].as_i64())
                .max()
                .unwrap_or(0)
                + 1;
            let skill = json!({"id":Uuid::new_v4().to_string(),"agentId":agent_id,"name":title,"description":args["description"].as_str().unwrap_or(""),"content":content,"version":version,"status":"proposed","createdAt":iso(now())});
            WorkspaceStore::put_in(&mut tx, Table::Skills, &skill).await?;
            skill
        }
        _ => return Err(ApiError::new(403, "此任务未授予该工具。")),
    };
    access.authorize(state).await?;
    active.family.authorize(state).await?;
    check_fence(active, generation)?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(json!({"content":[{"type":"text","text":output.to_string()}],"details":output}))
}
