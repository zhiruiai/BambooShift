use super::{draft, store};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields, text},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct ProposalContext {
    pub conversation_id: String,
    pub thread_root_id: Option<String>,
    pub agent_id: String,
    pub input_message_id: String,
    pub root_run_id: String,
    pub tool_call_id: String,
    pub agent_snapshot: Vec<Value>,
    pub authorize: Arc<dyn Fn() -> Result<()> + Send + Sync>,
}
async fn current(state: &State, grant: &WorkspaceAccess, context: &ProposalContext) -> Result<()> {
    (context.authorize)()?;
    grant.authorize(state).await?;
    let active = state
        .agent_runs
        .get(&format!(
            "{}:{}",
            grant.workspace_id, context.conversation_id
        ))
        .await
        .ok_or_else(|| ApiError::new(409, "原任务已结束，不能保存迟到提案。"))?;
    if active.background
        || active.run_id != context.root_run_id
        || active.message_id != context.input_message_id
        || active.thread_root_id != context.thread_root_id
        || active.agent_id != context.agent_id
        || active.user_id != grant.user_id
        || active.finished.load(std::sync::atomic::Ordering::Acquire)
    {
        return Err(ApiError::new(403, "团队提案缺少当前人工任务来源。"));
    }
    (context.authorize)()
}
/// Only the trusted root runtime may supply this context; no HTTP route accepts it.
pub async fn propose(
    state: &State,
    grant: &WorkspaceAccess,
    context: &ProposalContext,
    input: &Value,
) -> Result<Value> {
    only_fields(input, &["goal", "draft"])?;
    let goal = text(&input["goal"], "工作目标", 6000)?;
    draft::uuid(&json!(context.root_run_id))?;
    if context.tool_call_id.is_empty()
        || context.tool_call_id.len() > 512
        || context.tool_call_id.chars().any(char::is_control)
    {
        return Err(ApiError::bad("团队提案工具标识无效。"));
    }
    current(state, grant, context).await?;
    let ws = grant.store(state).await?;
    let mut tx = ws.begin().await?;
    current(state, grant, context).await?;
    let digest = draft::digest(
        &json!({"goal":goal,"draft":input["draft"],"conversationId":context.conversation_id,"agentId":context.agent_id,"inputMessageId":context.input_message_id,"userId":grant.user_id}),
    );
    if let Some(id) = sqlx::query_scalar::<_, String>(
        "SELECT plan_id FROM bot_team_proposals WHERE root_run_id=?",
    )
    .bind(&context.root_run_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        let saved = store::get(&mut tx, &id).await?;
        if saved["proposal"]["toolCallId"] != context.tool_call_id
            || saved["proposal"]["digest"] != digest
        {
            return Err(ApiError::new(409, "本轮已提出团队方案，请先查看原方案。"));
        }
        current(state, grant, context).await?;
        tx.commit().await?;
        return Ok(saved["plan"].clone());
    }
    let source = WorkspaceStore::get_in(&mut tx, Table::Messages, &context.input_message_id)
        .await?
        .ok_or_else(|| ApiError::new(409, "原消息已移除。"))?;
    let chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, &context.conversation_id)
        .await?
        .ok_or_else(|| ApiError::new(409, "原聊天已移除。"))?;
    if source["role"] != "user"
        || source["userId"] != grant.user_id
        || source["conversationId"] != context.conversation_id
        || source["threadRootId"].as_str() != context.thread_root_id.as_deref()
        || !crate::agent::mentions::delivered_to(&source, &context.agent_id, &context.root_run_id)
        || !chat["agentIds"]
            .as_array()
            .is_some_and(|ids| ids.contains(&json!(context.agent_id)))
        || ["routineOperation", "routineRun", "memoryImport"]
            .iter()
            .any(|key| source["metadata"].get(key).is_some())
    {
        return Err(ApiError::new(403, "原消息不允许发起团队提案。"));
    }
    let proposal = draft::validate(
        &mut tx,
        &input["draft"],
        &context.agent_snapshot,
        None,
        false,
        false,
    )
    .await?;
    let agents = super::live::agents(state, grant, &mut tx).await?;
    draft::validate(&mut tx, &proposal, &agents, None, false, false).await?;
    let catalog = draft::catalog(&context.agent_snapshot);
    for member in proposal["members"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["kind"] == "reuse")
    {
        let agent = agents
            .iter()
            .find(|a| a["id"] == member["agentId"])
            .unwrap();
        if catalog[member["agentId"].as_str().unwrap()] != draft::version(agent) {
            return Err(ApiError::new(
                409,
                "复用 Bot 资料在规划期间发生变化，请重新提出方案。",
            ));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let message_id = uuid::Uuid::new_v4().to_string();
    let timestamp = iso(now());
    let saved = json!({"plan":{"id":id,"requestId":uuid::Uuid::new_v4().to_string(),"revision":uuid::Uuid::new_v4().to_string(),"goal":goal,"draft":proposal,"status":"ready","createdAt":timestamp,"updatedAt":timestamp,"source":{"kind":"conversation","conversationId":context.conversation_id,"agentId":context.agent_id,"messageId":message_id,"userId":grant.user_id}},"catalog":catalog,"createdBy":grant.user_id,"proposal":{"rootRunId":context.root_run_id,"toolCallId":context.tool_call_id,"inputMessageId":context.input_message_id,"digest":digest,"agents":agents.iter().map(|a|json!({"id":a["id"],"name":a["name"],"role":a["role"]})).collect::<Vec<_>>()}});
    sqlx::query("INSERT INTO bot_team_proposals VALUES(?,?)")
        .bind(&context.root_run_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let mut message = json!({"id":message_id,"conversationId":context.conversation_id,"agentId":context.agent_id,"role":"assistant","kind":"text","status":"done","content":"","createdAt":timestamp});
    crate::agent::threads::stamp(&mut message, context.thread_root_id.as_deref());
    WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
    let card = store::save(&mut tx, &saved).await?;
    let mut chat = chat;
    chat["updatedAt"] = json!(timestamp);
    WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
    current(state, grant, context).await?;
    tx.commit().await?;
    store::notify(&ws, card);
    Ok(saved["plan"].clone())
}
