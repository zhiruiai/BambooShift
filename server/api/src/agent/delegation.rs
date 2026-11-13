use super::{
    authority::ExecutionAccess,
    private_delegation,
    registry::ActiveRun,
    runner,
    tools::{self, ToolContext},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields, text},
    workspace::{Table, WorkspaceStore},
};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize},
};
use tokio::sync::{Notify, mpsc};

pub(crate) fn delegate<'a>(
    state: &'a State,
    access: &'a ExecutionAccess,
    store: &'a Arc<WorkspaceStore>,
    context: &'a ToolContext<'a>,
    args: &'a Value,
) -> BoxFuture<'a, Result<Value>> {
    Box::pin(async move {
        only_fields(args, &["agentId", "task"])?;
        let target = text(&args["agentId"], "同事", 128)?;
        let task = text(&args["task"], "委派任务", 12000)?;
        let parent = context.active;
        if ["memory_import", "primary_checkin"].contains(&parent.kind) || parent.depth >= 2 {
            return Err(ApiError::new(403, "此任务不能继续委派。"));
        }
        if parent.lineage.contains(&target) {
            return Err(ApiError::new(409, "不能向自己或本次任务的上级重复委派。"));
        }
        if parent
            .family
            .mentioned_agents
            .get()
            .is_some_and(|agents| agents.contains(&target))
        {
            return Err(ApiError::new(
                409,
                "发起者已直接提及这位 Bot，请让其独立回复。",
            ));
        }
        let generation = context.generation;
        tools::check_fence(parent, generation)?;
        access.authorize(state).await?;
        parent.family.authorize(state).await?;
        let snapshot = parent
            .family
            .snapshot(&parent.conversation_id)
            .ok_or_else(|| ApiError::new(409, "本次工作组快照不可用，请重新开始任务。"))?;
        let child_access = base_access(access)?;
        let reservation = parent.family.reserve()?;
        if let Some(source) = access.shared() {
            parent.family.add_source(source.clone());
        }
        let mut tx = store.begin().await?;
        let conversation =
            WorkspaceStore::get_in(&mut tx, Table::Conversations, &parent.conversation_id)
                .await?
                .ok_or_else(|| ApiError::new(409, "原会话已不存在。"))?;
        let (destination, direct_grant) = if snapshot["isGroup"] == true {
            if conversation["isGroup"] != true
                || !member(&snapshot, &target)
                || !member(&snapshot, &parent.agent_id)
                || !member(&conversation, &target)
                || !member(&conversation, &parent.agent_id)
            {
                return Err(ApiError::new(
                    409,
                    "只能向本轮工作组仍在群内的同事委派任务。",
                ));
            }
            (conversation.clone(), None)
        } else {
            let (chat, grant) = private_delegation::destination(
                &mut tx,
                access,
                store,
                parent,
                &conversation,
                &target,
            )
            .await?;
            (chat, Some(grant))
        };
        let destination_id = destination["id"].as_str().unwrap().to_owned();
        let mut bot = WorkspaceStore::get_in(&mut tx, Table::Agents, &target)
            .await?
            .ok_or_else(|| ApiError::new(409, "同事已不存在。"))?;
        if state
            .agent_runs
            .agent_busy(access.workspace_id(), &target, None)
            .await
        {
            return Err(ApiError::new(
                409,
                "这位同事正在执行其他任务，请等待其完成。",
            ));
        }
        let (commands, mut receiver) = mpsc::channel(16);
        let mid = uuid::Uuid::new_v4().to_string();
        let mut lineage = parent.lineage.clone();
        lineage.push(target.clone());
        let active = Arc::new(ActiveRun {
            run_id: uuid::Uuid::new_v4().to_string(),
            root_run_id: parent.root_run_id.clone(),
            requester_message_id: parent.requester_message_id.clone(),
            depth: parent.depth + 1,
            admitted_generation: generation,
            lineage,
            family: parent.family.clone(),
            user_id: parent.user_id.clone(),
            user_name: parent.user_name.clone(),
            message_id: mid.clone(),
            conversation_id: destination_id.clone(),
            thread_root_id: parent
                .thread_root_id
                .clone()
                .filter(|_| destination_id == parent.conversation_id),
            agent_id: target.clone(),
            background: parent.background,
            kind: "delegated",
            memory_writes: AtomicUsize::new(0),
            memory_characters: AtomicUsize::new(0),
            cancelled: parent.cancelled.clone(),
            generation: parent.generation.clone(),
            commands,
            finished: AtomicBool::new(false),
            changed: Notify::new(),
        });
        let direct_claim = if direct_grant.is_some() {
            Some(private_delegation::ConversationClaim::acquire(state, store, &active).await?)
        } else {
            None
        };
        let mut lease = parent.family.track(active.clone(), reservation);
        state.teaching.interrupt_bot(access.workspace_id(), &target);
        let marker = json!({"parentRunId":parent.run_id,"rootRunId":parent.root_run_id,"sourceAgentId":parent.agent_id,"targetAgentId":target,"depth":active.depth,"toolCallId":context.call_id,"requesterMessageId":parent.requester_message_id,"sourceConversationId":parent.conversation_id,"targetConversationId":destination_id});
        let mut input = json!({"id":mid,"conversationId":destination_id,"agentId":target,"role":"system","kind":"activity","content":format!("委派给 {}：{}",bot["name"].as_str().unwrap_or("同事"),task),"executionPrompt":task,"createdAt":iso(now()),"delivery":{"state":"queued","mode":"followUp","agentId":target,"runId":active.run_id},"metadata":{"delegation":marker}});
        super::threads::stamp(&mut input, active.thread_root_id.as_deref());
        let projection = direct_grant.as_ref().map(|_| {
            private_delegation::card(
                parent,
                &target,
                bot["name"].as_str().unwrap_or("Bot"),
                &task,
                &marker,
            )
        });
        if let Some(card) = &projection {
            WorkspaceStore::put_in(&mut tx, Table::Messages, card).await?;
        }
        WorkspaceStore::put_in(&mut tx, Table::Messages, &input).await?;
        bot["status"] = json!("working");
        WorkspaceStore::put_in(&mut tx, Table::Agents, &bot).await?;
        access.authorize(state).await?;
        parent.family.authorize(state).await?;
        tools::check_fence(parent, generation)?;
        if let Some(grant) = &direct_grant {
            grant.authorize(state).await?;
        }
        tx.commit().await?;
        lease.admit();
        if let Some(grant) = direct_grant {
            parent.family.add_direct(grant);
        }
        parent.family.capture_conversation(destination);
        if let Some(card) = &projection {
            store.emit("message", card.clone());
        }
        store.emit("message", input.clone());
        store.emit("update", json!({}));
        let mut result = json!({"id":uuid::Uuid::new_v4().to_string(),"conversationId":destination_id,"agentId":target,"role":"assistant","kind":"text","content":"","status":"running","createdAt":iso(now()),"metadata":{"runId":active.run_id,"inputMessageId":mid,"delegation":marker}});
        super::threads::stamp(&mut result, active.thread_root_id.as_deref());
        let outcome = runner::execute(
            state,
            &child_access,
            store,
            &active,
            &mut receiver,
            &input,
            &mut result,
        )
        .await;
        if let Err(error) = outcome {
            result["status"] = json!("error");
            result["metadata"]["executionStatus"] = json!(if error.status.as_u16() == 409 {
                "cancelled"
            } else if [401, 403, 503].contains(&error.status.as_u16()) {
                "interrupted"
            } else {
                "error"
            });
            let previous = result["content"].as_str().unwrap_or("");
            result["content"] = json!(if previous.is_empty() {
                error.message
            } else {
                format!("{previous}\n\n{}", error.message)
            });
        }
        let saved = runner::finalize(
            state,
            &child_access,
            store,
            &active,
            &destination_id,
            &mut result,
        )
        .await;
        drop(lease);
        if let Some(claim) = direct_claim {
            claim.release().await;
        }
        let authorized = async {
            access.authorize(state).await?;
            parent.family.authorize(state).await?;
            tools::check_fence(parent, generation)
        }
        .await;
        if let Some(card) = &projection {
            let mut visible = result.clone();
            if saved.is_err() || authorized.is_err() {
                visible["status"] = json!("error");
            }
            private_delegation::finish_card(
                state, access, store, parent, generation, card, &visible,
            )
            .await?;
        }
        if saved? {
            store.emit("message", result.clone());
        }
        store.emit("update", json!({}));
        authorized?;
        let deliveries =
            super::delegation_receipts::collect(store, &active.run_id, &destination_id, &target)
                .await?;
        access.authorize(state).await?;
        parent.family.authorize(state).await?;
        tools::check_fence(parent, generation)?;
        let content = result["content"].as_str().unwrap_or("");
        let excerpt = content.chars().take(16000).collect::<String>();
        let details = json!({"agentId":target,"conversationId":destination_id,"resultMessageId":result["id"],"status":if result["status"]=="done" {"completed"} else {"error"},"content":excerpt,"truncated":content.chars().count()>16000,"deliveries":deliveries,"acceptance":"requires_review"});
        Ok(
            json!({"content":[{"type":"text","text":details.to_string()}],"details":details,"isError":result["status"]!="done"}),
        )
    })
}
fn member(conversation: &Value, id: &str) -> bool {
    conversation["agentIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|a| a == id))
}
fn base_access(access: &ExecutionAccess) -> Result<ExecutionAccess> {
    match access {
        ExecutionAccess::User(actor) | ExecutionAccess::SharedUser { actor, .. } => {
            Ok(ExecutionAccess::User(actor.clone()))
        }
        ExecutionAccess::Background(actor) | ExecutionAccess::SharedBackground { actor, .. } => {
            Ok(ExecutionAccess::Background(actor.clone()))
        }
        ExecutionAccess::MemoryImport { .. } => Err(ApiError::new(403, "记忆导入不能委派任务。")),
    }
}
