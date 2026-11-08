use super::{Authority, interactive_rules as rules, model, policy_data, store, tool_access};
use crate::{
    db::{State, iso, now},
    error::Result,
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::sync::Arc;
use uuid::Uuid;

const GITHUB_READONLY: &str = "https://api.githubcopilot.com/mcp/readonly";

#[derive(Clone)]
pub struct Candidate {
    pub actor: WorkspaceAccess,
    pub conversation_id: String,
    pub agent_id: String,
    pub requester_message_id: String,
    pub run_id: String,
    pub connection_id: String,
    pub connection_revision: String,
}

#[derive(Clone)]
pub(crate) struct Scope {
    pub digest: String,
    agent_name: String,
    conversation_title: String,
    catalog: Vec<Value>,
}

impl Candidate {
    pub(crate) fn applies(
        &self,
        recipient: &WorkspaceStore,
        source: &WorkspaceStore,
        context: &super::actions::ActionContext,
        prepared: &model::PreparedCall,
    ) -> bool {
        rules::allowed(&self.actor)
            && recipient.workspace_id == self.actor.workspace_id
            && source.workspace_id == recipient.workspace_id
            && context.thread_root_id.is_none()
            && context.source.is_none()
            && context.conversation_id == self.conversation_id
            && context.agent_id == self.agent_id
            && context.run_id == self.run_id
            && context.requester.as_ref().is_some_and(|user| {
                user["userId"] == self.actor.user_id
                    && user["messageId"] == self.requester_message_id
            })
            && prepared.connection_id == self.connection_id
            && prepared.connection_revision == self.connection_revision
            && exact_issue(prepared)
    }

    fn request_key(&self, prepared: &model::PreparedCall) -> String {
        model::hash(&json!([
            self.actor.user_id,
            self.requester_message_id,
            self.conversation_id,
            self.agent_id,
            self.connection_id,
            prepared.tool_name,
            prepared.arguments
        ]))
    }

    pub(crate) async fn used(
        &self,
        tx: &mut SqliteConnection,
        prepared: &model::PreparedCall,
    ) -> Result<Option<String>> {
        Ok(sqlx::query_scalar(
            "SELECT action_id FROM app_interactive_uses WHERE run_id=? AND request_key=?",
        )
        .bind(&self.run_id)
        .bind(self.request_key(prepared))
        .fetch_optional(tx)
        .await?)
    }

    pub(crate) async fn use_action(
        &self,
        tx: &mut SqliteConnection,
        prepared: &model::PreparedCall,
        action_id: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO app_interactive_uses VALUES(?,?,?)")
            .bind(&self.run_id)
            .bind(self.request_key(prepared))
            .bind(action_id)
            .execute(tx)
            .await?;
        Ok(())
    }

    pub(crate) async fn inspect(
        &self,
        tx: &mut SqliteConnection,
        prepared: &model::PreparedCall,
    ) -> Result<Option<Scope>> {
        let Some(connection) = store::connection_in(tx, &self.connection_id).await? else {
            return Ok(None);
        };
        if ![
            GITHUB_READONLY,
            "https://api.githubcopilot.com/mcp/readonly/",
        ]
        .contains(&connection.url.as_str())
            || connection.status != "connected"
            || connection.auth_type != "bearer"
            || connection.revision != self.connection_revision
            || !connection.tools.iter().any(|tool| tool == &prepared.tool)
            || !tool_access::current(
                &connection,
                &prepared.tool_name,
                prepared.tool_access_revision.as_deref(),
            )
            || !exact_issue(prepared)
        {
            return Ok(None);
        }
        let Some(chat) =
            WorkspaceStore::get_in(tx, Table::Conversations, &self.conversation_id).await?
        else {
            return Ok(None);
        };
        let Some(agent) = WorkspaceStore::get_in(tx, Table::Agents, &self.agent_id).await? else {
            return Ok(None);
        };
        let Some(message) =
            WorkspaceStore::get_in(tx, Table::Messages, &self.requester_message_id).await?
        else {
            return Ok(None);
        };
        if chat["isGroup"] != false
            || chat["agentIds"] != json!([self.agent_id])
            || agent.get("sharedBot").is_some()
            || message["role"] != "user"
            || message["kind"] != "text"
            || message["userId"] != self.actor.user_id
            || message["conversationId"] != self.conversation_id
            || !message["threadRootId"].is_null()
            || message.get("mentions").is_some()
            || message["appContext"]["connectionId"] != self.connection_id
            || message["appContext"]["revision"] != self.connection_revision
            || !crate::agent::mentions::delivered_to(&message, &self.agent_id, &self.run_id)
        {
            return Ok(None);
        }
        let Some(agent_name) = agent["name"].as_str() else {
            return Ok(None);
        };
        let Some(config_revision) = agent["configRevision"].as_str() else {
            return Ok(None);
        };
        let mut scope = json!({
            "issuer":self.actor.user_id,"workspace":self.actor.workspace_id,
            "conversation":self.conversation_id,"agent":self.agent_id,"botRevision":config_revision,
            "connection":self.connection_id,"connectionRevision":self.connection_revision,
            "endpoint":connection.url,"credentialRef":connection.credential_ref,
            "authorization":connection.authorization,"catalog":policy_data::catalog_revision(&connection),
            "tool":prepared.tool_name,"schema":prepared.schema_hash,"input":prepared.arguments
        });
        if let Some(revision) = &prepared.tool_access_revision {
            scope["toolAccessRevision"] = json!(revision);
        }
        Ok(Some(Scope {
            digest: model::hash(&scope),
            agent_name: agent_name.to_owned(),
            conversation_title: chat["title"]
                .as_str()
                .filter(|title| !title.is_empty())
                .unwrap_or(agent_name)
                .to_owned(),
            catalog: connection.tools,
        }))
    }

    pub(crate) fn authority(
        &self,
        state: &State,
        workspace: &Arc<WorkspaceStore>,
        prepared: &model::PreparedCall,
        digest: &str,
        rule_id: &str,
    ) -> Authority {
        let (state, workspace, prepared, digest, rule_id, candidate) = (
            state.clone(),
            workspace.clone(),
            prepared.clone(),
            digest.to_owned(),
            rule_id.to_owned(),
            self.clone(),
        );
        Arc::new(move || {
            let (state, workspace, prepared, digest, rule_id, candidate) = (
                state.clone(),
                workspace.clone(),
                prepared.clone(),
                digest.clone(),
                rule_id.clone(),
                candidate.clone(),
            );
            Box::pin(async move {
                candidate.actor.authorize_owner(&state).await?;
                let mut conn = workspace.pool.acquire().await?;
                if rules::active_id(&mut conn, &candidate.actor.user_id, &digest)
                    .await?
                    .as_deref()
                    != Some(&rule_id)
                    || !candidate
                        .inspect(&mut conn, &prepared)
                        .await?
                        .is_some_and(|scope| scope.digest == digest)
                {
                    return Err(rules::changed());
                }
                Ok(())
            })
        })
    }
}

impl Scope {
    pub(crate) fn pending(&self) -> Value {
        json!({"eligible":true,"agentName":self.agent_name,"conversationTitle":self.conversation_title})
    }

    pub(crate) fn mark(&self, saved: &mut Value, rule_id: &str, usage: &str, issuer: &str) {
        saved["interactiveRuleId"] = json!(rule_id);
        saved["approvedBy"] = json!(issuer);
        saved["action"]["status"] = json!("running");
        saved["action"]["interactiveApproval"] = json!({
            "eligible":false,"ruleId":rule_id,"usage":usage,
            "agentName":self.agent_name,"conversationTitle":self.conversation_title
        });
    }

    pub(crate) fn restrict(&self, mut prepared: model::PreparedCall) -> model::PreparedCall {
        prepared.expected_catalog = Some(self.catalog.clone());
        prepared
    }

    pub(crate) async fn save(
        &self,
        tx: &mut SqliteConnection,
        candidate: &Candidate,
        prepared: &model::PreparedCall,
    ) -> Result<(String, &'static str)> {
        let issuer = &candidate.actor.user_id;
        if let Some(id) = rules::active_id(tx, issuer, &self.digest).await? {
            return Ok((id, "reused"));
        }
        let id = Uuid::new_v4().to_string();
        let rule = json!({"id":id,"agentId":candidate.agent_id,"agentName":self.agent_name,
            "conversationId":candidate.conversation_id,"conversationTitle":self.conversation_title,
            "connectionId":candidate.connection_id,"connectionName":prepared.app_name,
            "toolName":prepared.tool_name,"input":prepared.arguments,"createdAt":iso(now())});
        rules::insert(tx, issuer, &self.digest, &rule).await?;
        Ok((id, "saved"))
    }
}

fn exact_issue(prepared: &model::PreparedCall) -> bool {
    let input = &prepared.arguments;
    let slug = |key: &str, limit: usize, extras: &[u8]| {
        input[key].as_str().is_some_and(|value| {
            !value.is_empty()
                && value.len() <= limit
                && ![".", ".."].contains(&value)
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || extras.contains(&b))
        })
    };
    prepared.tool_name == "issue_read"
        && policy_data::read_only(&prepared.tool)
        && input.as_object().is_some_and(|map| map.len() == 4)
        && input["method"] == "get"
        && slug("owner", 39, b"-")
        && slug("repo", 100, b"-_.")
        && input["issue_number"]
            .as_u64()
            .is_some_and(|number| (1..=i32::MAX as u64).contains(&number))
}
