use super::{
    catalog,
    files::{SharedFile, UsedFile},
    references::{self, Reference},
    source::{self, SourceDatabase},
    store::{Share, unavailable},
};
use crate::{db::State, error::Result, workspace::WorkspaceAccess};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
enum RunActor {
    User(WorkspaceAccess),
    Owner {
        user: String,
        workspace: String,
        storage_key: String,
    },
}
impl RunActor {
    fn user_id(&self) -> &str {
        match self {
            Self::User(a) => &a.user_id,
            Self::Owner { user, .. } => user,
        }
    }
    async fn store(
        &self,
        state: &State,
    ) -> Result<std::sync::Arc<crate::workspace::WorkspaceStore>> {
        self.authorize(state).await?;
        match self {
            Self::User(a) => a.store(state).await,
            Self::Owner {
                workspace,
                storage_key,
                ..
            } => state.workspace.get(workspace, storage_key).await,
        }
    }
    async fn authorize(&self, state: &State) -> Result<()> {
        match self {
            Self::User(a) => {
                references::personal(state, a).await?;
            }
            Self::Owner {
                user,
                workspace,
                storage_key,
            } => {
                source::member(state, user, workspace, true).await?;
                let current = source::workspace(state, workspace).await?;
                if current.kind != "personal" || current.key != *storage_key {
                    return Err(unavailable());
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct SharedBotRunGrant {
    actor: RunActor,
    reference: Reference,
    access_revision: String,
    pub share_id: String,
    pub source_workspace_id: String,
    pub source_agent_id: String,
    pub(crate) files: Vec<Value>,
    apps: Vec<Value>,
    used_files: Arc<Mutex<Vec<UsedFile>>>,
    used_apps: Arc<Mutex<Vec<Value>>>,
}
pub struct ResolvedSharedBot {
    pub agent: Value,
    pub skills: Vec<Value>,
    pub grant: SharedBotRunGrant,
    pub files: Vec<Value>,
    pub apps: Vec<Value>,
}
impl SharedBotRunGrant {
    async fn current(&self, state: &State) -> Result<Share> {
        self.actor.authorize(state).await?;
        let store = self.actor.store(state).await?;
        let mut conn = store.pool.acquire().await?;
        if references::by_agent(&mut conn, &self.reference.agent_id)
            .await?
            .as_ref()
            != Some(&self.reference)
        {
            return Err(unavailable());
        }
        references::validate(&mut conn, &self.reference, self.actor.user_id()).await?;
        let share = state.shared_bots.get(&self.share_id).await?;
        if share.access_revision != self.access_revision
            || share.source_workspace_id != self.source_workspace_id
            || share.source_agent_id != self.source_agent_id
        {
            return Err(unavailable());
        }
        let (workspace, _, _) =
            catalog::authorize_share(state, self.actor.user_id(), &share).await?;
        SourceDatabase::open(state, &workspace)
            .await?
            .agent(&share.source_agent_id)
            .await?;
        Ok(share)
    }
    pub async fn authorize(&self, state: &State) -> Result<()> {
        self.current(state).await?;
        let files = self.used_files.lock().map_err(|_| unavailable())?.clone();
        for file in files {
            file.authorize(state).await.map_err(|_| unavailable())?;
        }
        let apps = self.used_apps.lock().map_err(|_| unavailable())?.clone();
        if !apps.is_empty() {
            let workspace = source::workspace(state, &self.source_workspace_id).await?;
            for app in apps {
                super::source_apps::selected_tools(state, &workspace, &app)
                    .await
                    .map_err(|_| unavailable())?;
            }
        }
        self.actor.authorize(state).await?;
        Ok(())
    }
    pub async fn read_file(&self, state: &State, id: &str) -> Result<SharedFile> {
        self.authorize(state).await?;
        let selected = self
            .files
            .iter()
            .find(|f| f["fileId"] == id)
            .ok_or_else(unavailable)?;
        let workspace = source::workspace(state, &self.source_workspace_id).await?;
        let (actual, file, used) =
            super::files::read(state, &workspace, id, selected["revision"].as_str()).await?;
        if actual != *selected {
            return Err(unavailable());
        }
        self.used_files
            .lock()
            .map_err(|_| unavailable())?
            .push(used);
        self.authorize(state).await?;
        Ok(file)
    }
    pub async fn app_source_store(
        &self,
        state: &State,
    ) -> Result<Arc<crate::workspace::WorkspaceStore>> {
        self.authorize(state).await?;
        let workspace = source::workspace(state, &self.source_workspace_id).await?;
        let mut source = SourceDatabase::open(state, &workspace).await?;
        if !source.exists("app_connections").await? {
            return Err(unavailable());
        }
        let store = state
            .workspace
            .attach_app_source(&workspace.id, &workspace.key)
            .await?;
        source.check()?;
        self.authorize(state).await?;
        Ok(store)
    }
    pub async fn available_apps(&self, state: &State) -> Result<Vec<Value>> {
        self.authorize(state).await?;
        if self.apps.is_empty() {
            return Ok(Vec::new());
        }
        let workspace = source::workspace(state, &self.source_workspace_id).await?;
        let mut result = Vec::new();
        for grant in &self.apps {
            if let Ok(selection) =
                super::source_apps::available_selection(state, &workspace, grant).await
            {
                result.push(selection);
            }
        }
        self.authorize(state).await?;
        Ok(result)
    }
    pub async fn app_tools(&self, state: &State, id: &str) -> Result<Vec<Value>> {
        self.authorize(state).await?;
        let selected = self
            .apps
            .iter()
            .find(|a| a["connectionId"] == id)
            .ok_or_else(unavailable)?;
        let workspace = source::workspace(state, &self.source_workspace_id).await?;
        let tools = super::source_apps::available_tools(state, &workspace, selected).await?;
        self.authorize(state).await?;
        Ok(tools)
    }
    pub async fn authorize_app(&self, state: &State, id: &str, tool: &str) -> Result<Value> {
        let mut selected = self
            .apps
            .iter()
            .find(|a| a["connectionId"] == id)
            .cloned()
            .ok_or_else(unavailable)?;
        let item = selected["tools"]
            .as_array()
            .and_then(|ts| ts.iter().find(|t| t["name"] == tool))
            .cloned()
            .ok_or_else(unavailable)?;
        selected["tools"] = json!([item]);
        let workspace = source::workspace(state, &self.source_workspace_id).await?;
        self.authorize(state).await?;
        let tools = super::source_apps::selected_tools(state, &workspace, &selected).await?;
        self.used_apps
            .lock()
            .map_err(|_| unavailable())?
            .push(selected);
        self.authorize(state).await?;
        Ok(tools[0].clone())
    }
}
pub async fn resolve(
    state: &State,
    actor: &WorkspaceAccess,
    alias: &str,
) -> Result<ResolvedSharedBot> {
    references::personal(state, actor).await?;
    resolve_actor(state, RunActor::User(actor.clone()), alias).await
}
pub(crate) async fn resolve_owner(
    state: &State,
    user: &str,
    workspace: &str,
    alias: &str,
) -> Result<ResolvedSharedBot> {
    let current = source::workspace(state, workspace).await?;
    let actor = RunActor::Owner {
        user: user.to_owned(),
        workspace: workspace.to_owned(),
        storage_key: current.key,
    };
    actor.authorize(state).await?;
    resolve_actor(state, actor, alias).await
}
async fn resolve_actor(state: &State, actor: RunActor, alias: &str) -> Result<ResolvedSharedBot> {
    let store = actor.store(state).await?;
    let reference = references::by_agent(&mut *store.pool.acquire().await?, alias)
        .await?
        .ok_or_else(unavailable)?;
    let mut agent = references::validate(
        &mut *store.pool.acquire().await?,
        &reference,
        actor.user_id(),
    )
    .await?;
    let definition = catalog::definition(state, actor.user_id(), &reference.share_id).await?;
    for (key, value) in definition.source.profile.as_object().unwrap() {
        agent[key] = value.clone();
    }
    agent["avatarImageId"] = Value::Null;
    agent["sharedBot"] = catalog::metadata(&definition);
    let files = definition.share.files.clone().unwrap_or_default();
    let grant = SharedBotRunGrant {
        actor,
        reference,
        access_revision: definition.share.access_revision,
        share_id: definition.share.id,
        source_workspace_id: definition.share.source_workspace_id,
        source_agent_id: definition.share.source_agent_id,
        files: files.clone(),
        apps: definition.share.apps.unwrap_or_default(),
        used_files: Arc::new(Mutex::new(Vec::new())),
        used_apps: Arc::new(Mutex::new(Vec::new())),
    };
    let apps = grant.available_apps(state).await?;
    Ok(ResolvedSharedBot {
        agent,
        skills: definition.source.skills,
        grant,
        files,
        apps,
    })
}
pub async fn project_snapshot(
    state: &State,
    actor: &WorkspaceAccess,
    data: &mut Value,
) -> Result<()> {
    let Some(agents) = data["agents"].as_array_mut() else {
        return Ok(());
    };
    let mut skills = Vec::new();
    for agent in agents {
        if agent.get("sharedBot").is_none() {
            continue;
        }
        match resolve(state, actor, agent["id"].as_str().unwrap_or("")).await {
            Ok(resolved) => {
                *agent = resolved.agent;
                for mut skill in resolved.skills {
                    let digest = super::store::sha(
                        serde_json::to_vec(&json!([agent["id"], skill["id"]])).unwrap(),
                    );
                    skill["id"] = json!(format!(
                        "{}-{}-{}-{}-{}",
                        &digest[..8],
                        &digest[8..12],
                        &digest[12..16],
                        &digest[16..20],
                        &digest[20..32]
                    ));
                    skill["agentId"] = agent["id"].clone();
                    skills.push(skill);
                }
            }
            Err(_) => {
                let mut marker = agent["sharedBot"].clone();
                if !marker.is_object() {
                    marker = json!({});
                }
                marker["status"] = json!("unavailable");
                marker["reason"] = json!("此Bot的分享或团队权限已不可用；你的历史会话仍保留。");
                marker.as_object_mut().unwrap().remove("avatarPath");
                agent["sharedBot"] = marker;
                agent["avatarImageId"] = Value::Null;
            }
        }
    }
    if let Some(current) = data["skills"].as_array_mut() {
        current.extend(skills);
    }
    actor.authorize(state).await?;
    Ok(())
}
pub async fn is_main_conversation(conn: &mut sqlx::SqliteConnection, id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM shared_bot_refs WHERE json_extract(data,'$.conversationId')=?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?
    .is_some())
}
