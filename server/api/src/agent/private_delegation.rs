use super::{
    authority::ExecutionAccess,
    queue,
    registry::{ActiveRun, AgentRegistry},
    run_context,
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore, primary},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct DirectGrant {
    store: Arc<WorkspaceStore>,
    actor: crate::workspace::WorkspaceAccess,
    source_agent: String,
    source_chat: String,
    target_agent: String,
    target_chat: String,
}
impl DirectGrant {
    pub async fn authorize(&self, state: &State) -> Result<()> {
        self.actor.authorize_owner(state).await?;
        for (agent, chat) in [
            (&self.source_agent, &self.source_chat),
            (&self.target_agent, &self.target_chat),
        ] {
            let bot = self.store.get(Table::Agents, agent).await?;
            let current = self.store.get(Table::Conversations, chat).await?;
            if bot
                .as_ref()
                .is_none_or(|bot| bot.get("sharedBot").is_some())
                || current
                    .as_ref()
                    .is_none_or(|chat| !run_context::direct(chat, agent))
            {
                return Err(ApiError::new(
                    409,
                    "委派的 Bot 或原私聊已变化，原任务已取消。",
                ));
            }
        }
        Ok(())
    }
}

pub(crate) async fn destination(
    conn: &mut SqliteConnection,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    parent: &ActiveRun,
    source: &Value,
    target: &str,
) -> Result<(Value, DirectGrant)> {
    let actor = access
        .as_user()
        .filter(|actor| actor.kind == "personal" && actor.is_owner)
        .ok_or_else(|| ApiError::new(403, "只有个人空间主 Bot 可以从私聊委派本地同事。"))?;
    if parent.kind != "user"
        || parent.depth != 0
        || access.shared().is_some()
        || !run_context::direct(source, &parent.agent_id)
    {
        return Err(ApiError::new(403, "此任务不能从私聊发起新的跨 Bot 委派。"));
    }
    let selected = primary::read(conn, &actor.kind).await?;
    if selected["agentId"] != parent.agent_id
        || selected["conversationId"] != parent.conversation_id
    {
        return Err(ApiError::new(
            409,
            "当前主 Bot 或其私聊已变化，请重新选择。",
        ));
    }
    let bot = WorkspaceStore::get_in(conn, Table::Agents, target)
        .await?
        .filter(|bot| bot.get("sharedBot").is_none())
        .ok_or_else(|| ApiError::new(403, "只能委派当前个人空间的本地 Bot。"))?;
    let mut chats = WorkspaceStore::list_in(conn, Table::Conversations)
        .await?
        .into_iter()
        .filter(|chat| run_context::direct(chat, target))
        .collect::<Vec<_>>();
    // A stable existing DM is selected by the server; callers cannot select another conversation.
    chats.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let chat = chats
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::new(409, "目标 Bot 尚无可用私聊，请先打开它的会话。"))?;
    let grant = DirectGrant {
        store: store.clone(),
        actor: actor.clone(),
        source_agent: parent.agent_id.clone(),
        source_chat: parent.conversation_id.clone(),
        target_agent: bot["id"].as_str().unwrap().to_owned(),
        target_chat: chat["id"].as_str().unwrap().to_owned(),
    };
    Ok((chat, grant))
}

pub(crate) struct ConversationClaim {
    state: State,
    store: Arc<WorkspaceStore>,
    key: Option<String>,
    run_id: String,
}
impl ConversationClaim {
    pub async fn acquire(
        state: &State,
        store: &Arc<WorkspaceStore>,
        active: &Arc<ActiveRun>,
    ) -> Result<Self> {
        let key = AgentRegistry::key(&store.workspace_id, &active.conversation_id);
        if !state.agent_runs.claim(&key, active.clone()).await {
            return Err(ApiError::new(
                409,
                "目标 Bot 的私聊正在工作，请等待其完成。",
            ));
        }
        Ok(Self {
            state: state.clone(),
            store: store.clone(),
            key: Some(key),
            run_id: active.run_id.clone(),
        })
    }
    pub async fn release(mut self) {
        if let Some(key) = self.key.take() {
            queue::advance(&self.state, &self.store, &key, &self.run_id).await;
        }
    }
}
impl Drop for ConversationClaim {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            let (state, store, id) = (self.state.clone(), self.store.clone(), self.run_id.clone());
            tokio::spawn(async move {
                queue::advance(&state, &store, &key, &id).await;
            });
        }
    }
}

pub(crate) fn card(
    parent: &ActiveRun,
    target: &str,
    name: &str,
    task: &str,
    marker: &Value,
) -> Value {
    let mut message = json!({"id":uuid::Uuid::new_v4().to_string(),"conversationId":parent.conversation_id,
        "agentId":target,"role":"assistant","kind":"activity","status":"running",
        "content":format!("已委派给 {name}：{task}"),"createdAt":iso(now()),
        "metadata":{"delegation":marker,"delegationProjection":true}});
    super::threads::stamp(&mut message, parent.thread_root_id.as_deref());
    message
}

pub(crate) async fn finish_card(
    state: &State,
    access: &ExecutionAccess,
    store: &WorkspaceStore,
    parent: &ActiveRun,
    generation: u64,
    card: &Value,
    result: &Value,
) -> Result<()> {
    let mut tx = store.begin().await?;
    let id = card["id"].as_str().unwrap();
    if let Some(mut current) = WorkspaceStore::get_in(&mut tx, Table::Messages, id).await? {
        current["status"] = result["status"].clone();
        current["content"] = json!(
            result["content"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(16000)
                .collect::<String>()
        );
        current["metadata"]["resultMessageId"] = result["id"].clone();
        current["metadata"]["resultConversationId"] = result["conversationId"].clone();
        if result["status"] != "done" {
            current["content"] = json!("委派未确认完成，请查看目标 Bot 的原会话。");
        }
        // Cleanup may publish a failure, but late success still requires the original authority.
        if current["status"] == "done"
            && (async {
                access.authorize(state).await?;
                parent.family.authorize(state).await?;
                super::tools::check_fence(parent, generation)
            })
            .await
            .is_err()
        {
            current["status"] = json!("error");
            current["content"] = json!("委派未确认完成，请查看目标 Bot 的原会话。");
        }
        WorkspaceStore::put_in(&mut tx, Table::Messages, &current).await?;
        tx.commit().await?;
        store.emit("message", current);
    }
    Ok(())
}
