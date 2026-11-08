use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::Value;
use sqlx::SqliteConnection;

pub async fn agents(
    state: &State,
    grant: &WorkspaceAccess,
    conn: &mut SqliteConnection,
) -> Result<Vec<Value>> {
    let mut agents = WorkspaceStore::list_in(conn, Table::Agents).await?;
    for agent in &mut agents {
        if agent.get("sharedBot").is_none() {
            continue;
        }
        match crate::shared_bots::resolve(state, grant, agent["id"].as_str().unwrap_or("")).await {
            Ok(resolved) => *agent = resolved.agent,
            Err(_) => {
                if !agent["sharedBot"].is_object() {
                    agent["sharedBot"] = serde_json::json!({});
                }
                agent["sharedBot"]["status"] = serde_json::json!("unavailable");
            }
        }
    }
    Ok(agents)
}
pub async fn source(
    state: &State,
    grant: &WorkspaceAccess,
    conn: &mut SqliteConnection,
    saved: &Value,
) -> Result<()> {
    super::store::source(conn, saved).await?;
    if let Some(id) = saved["plan"]["source"]["agentId"].as_str() {
        if let Some(agent) = WorkspaceStore::get_in(conn, Table::Agents, id).await? {
            if agent.get("sharedBot").is_some() {
                crate::shared_bots::resolve(state, grant, id).await?;
            }
        }
    }
    Ok(())
}
pub async fn recheck(
    state: &State,
    grant: &WorkspaceAccess,
    agents: &[Value],
    proposal: &Value,
) -> Result<()> {
    for member in proposal["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["kind"] == "reuse")
    {
        let id = member["agentId"].as_str().unwrap_or("");
        let previous = agents
            .iter()
            .find(|a| a["id"] == id)
            .ok_or_else(|| ApiError::new(409, "团队成员已变化。"))?;
        if previous.get("sharedBot").is_some() {
            let current = crate::shared_bots::resolve(state, grant, id).await?;
            if super::draft::version(&current.agent) != super::draft::version(previous) {
                return Err(ApiError::new(409, "共享Bot资料已变化，请重新核对。"));
            }
        }
    }
    grant.authorize_owner(state).await
}
