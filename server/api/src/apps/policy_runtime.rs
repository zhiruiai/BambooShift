use super::{
    Authority, actions,
    model::{self, PreparedCall},
    policy_data as data, store, tool_access,
};
use crate::{
    db::State,
    error::{ApiError, Result},
    scheduling::routines,
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct ScheduledCall {
    pub owner_id: String,
    pub run_id: String,
    pub active_run_id: String,
    pub routine_id: String,
    pub agent_id: String,
    pub conversation_id: String,
}
async fn current_run(store: &WorkspaceStore, run: &ScheduledCall) -> Result<Value> {
    let stored: Option<String> = sqlx::query_scalar("SELECT data FROM routine_runs WHERE run_id=?")
        .bind(&run.run_id)
        .fetch_optional(&store.pool)
        .await?;
    let saved: Value =
        serde_json::from_str(&stored.ok_or_else(data::conflict)?).map_err(|_| data::conflict())?;
    let input = store
        .get(Table::Messages, &run.run_id)
        .await?
        .ok_or_else(data::conflict)?;
    let routine = store
        .get(Table::Routines, &run.routine_id)
        .await?
        .ok_or_else(data::conflict)?;
    let bot = store
        .get(Table::Agents, &run.agent_id)
        .await?
        .ok_or_else(data::conflict)?;
    if bot.get("sharedBot").is_some()
        || saved["trigger"] != "scheduled"
        || saved["status"] != "running"
        || saved["routineId"] != run.routine_id
        || saved["agentId"] != run.agent_id
        || saved["conversationId"] != run.conversation_id
        || saved["inputMessageId"] != run.run_id
        || saved["routineConfig"] != routines::config(&routine)
        || input["role"] != "system"
        || input["delivery"]["runId"] != run.active_run_id
        || input["delivery"]["agentId"] != run.agent_id
        || input["conversationId"] != run.conversation_id
        || input["delivery"]["state"] != "delivered"
        || routine["enabled"] != true
    {
        return Err(data::conflict());
    }
    Ok(routine)
}
async fn verify(
    state: &State,
    store: &WorkspaceStore,
    run: &ScheduledCall,
    policy: &Value,
    prepared: &PreparedCall,
) -> Result<()> {
    let owner:Option<i64>=sqlx::query_scalar("SELECT 1 FROM workspaces w JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id WHERE w.id=? AND w.status='active' AND m.role='owner' AND u.id=? AND u.status='active'")
        .bind(&store.workspace_id).bind(&run.owner_id).fetch_optional(&state.pool).await?;
    if owner.is_none() {
        return Err(ApiError::new(403, "原应用预授权的拥有者资格已失效。"));
    }
    let current = data::get(
        &mut *store.pool.acquire().await?,
        policy["id"].as_str().unwrap_or(""),
    )
    .await?
    .ok_or_else(data::conflict)?;
    let routine = current_run(store, run).await?;
    let connection = store::connection(store, &prepared.connection_id).await?;
    let tool = connection
        .tools
        .iter()
        .find(|t| t["name"] == prepared.tool_name)
        .ok_or_else(data::conflict)?;
    if current["status"] != "active"
        || current["issuerUserId"] != run.owner_id
        || current["routineId"] != run.routine_id
        || current["routineConfig"] != routines::config(&routine)
        || current["connectionId"] != prepared.connection_id
        || current["connectionRevision"] != connection.revision
        || current["sourceRevision"] != data::source_revision(&connection)
        || current["catalogRevision"] != data::catalog_revision(&connection)
        || current["toolName"] != prepared.tool_name
        || current["toolRevision"]
            != data::tool_revision(tool, prepared.tool_access_revision.as_deref())
        || !tool_access::current(
            &connection,
            &prepared.tool_name,
            prepared.tool_access_revision.as_deref(),
        )
        || *tool != prepared.tool
        || !data::read_only(tool)
        || current["arguments"] != prepared.arguments
        || connection.status != "connected"
    {
        return Err(data::conflict());
    }
    Ok(())
}
pub(crate) async fn call(
    state: &State,
    store: &Arc<WorkspaceStore>,
    run: ScheduledCall,
    context: actions::ActionContext,
    prepared: PreparedCall,
    authorize: Authority,
) -> Result<Option<Value>> {
    authorize().await?;
    // An exact scheduled call gets one durable receipt, even if the model repeats it after an unknown result.
    let call_key = model::hash(
        &json!({"connectionId":prepared.connection_id,"tool":prepared.tool_name,"arguments":prepared.arguments}),
    );
    let lock = state
        .apps
        .lock(&format!(
            "policy-use:{}:{}:{call_key}",
            store.workspace_id, run.run_id
        ))
        .await;
    let guard = lock.lock().await;
    let prior: Option<String> =
        sqlx::query_scalar("SELECT action_id FROM app_policy_uses WHERE run_id=? AND call_key=?")
            .bind(&run.run_id)
            .bind(&call_key)
            .fetch_optional(&store.pool)
            .await?;
    if let Some(id) = prior {
        drop(guard);
        return actions::wait(state, store, &id, authorize).await.map(Some);
    }
    if current_run(store, &run).await.is_err() {
        return Ok(None);
    }
    let rows=sqlx::query("SELECT id FROM app_policies WHERE issuer_id=? AND routine_id=? AND connection_id=? AND status='active' ORDER BY rowid DESC")
        .bind(&run.owner_id).bind(&run.routine_id).bind(&prepared.connection_id).fetch_all(&store.pool).await?;
    let mut selected = None;
    for row in rows {
        if let Some(policy) = data::get(&mut *store.pool.acquire().await?, row.get("id")).await? {
            if verify(state, store, &run, &policy, &prepared).await.is_ok() {
                selected = Some(policy);
                break;
            }
        }
    }
    let Some(policy) = selected else {
        return Ok(None);
    };
    let mut prepared = prepared;
    prepared.expected_catalog = Some(
        store::connection(store, &prepared.connection_id)
            .await?
            .tools,
    );
    let approval: Authority = {
        let (state, store, run, policy, prepared) = (
            state.clone(),
            store.clone(),
            run.clone(),
            policy.clone(),
            prepared.clone(),
        );
        Arc::new(move || {
            let (state, store, run, policy, prepared) = (
                state.clone(),
                store.clone(),
                run.clone(),
                policy.clone(),
                prepared.clone(),
            );
            Box::pin(async move { verify(&state, &store, &run, &policy, &prepared).await })
        })
    };
    let action = actions::request(
        state,
        store.clone(),
        store.clone(),
        context,
        prepared,
        authorize.clone(),
    )
    .await?;
    let id = action["id"].as_str().unwrap();
    let lock = state.apps.lock(&format!("action:{id}")).await;
    let action_guard = lock.lock().await;
    let mut saved = super::store::get_raw(store, "app_actions", id).await?;
    if saved["action"]["status"] != "pending" {
        return Err(data::conflict());
    }
    let accepted=async {
        let mut tx=store.begin().await?;
        authorize().await?;approval().await?;
        sqlx::query("INSERT INTO app_policy_uses VALUES(?,?,?)").bind(&run.run_id).bind(&call_key).bind(id).execute(&mut *tx).await?;
        saved["action"]["policy"]=json!({"kind":"routine_read","policyId":policy["id"],"issuerUserId":policy["issuerUserId"],"routineId":policy["routineId"],"routineTitle":policy["routineTitle"],"issuedAt":policy["createdAt"]});
        saved["approvedBy"]=policy["issuerUserId"].clone();saved["action"]["status"]=json!("running");
        // Persist the fence and running action before any application network dispatch.
        sqlx::query("UPDATE app_actions SET data=? WHERE id=?").bind(saved.to_string()).bind(id).execute(&mut *tx).await?;
        authorize().await?;approval().await?;tx.commit().await?;Result::<()>::Ok(())
    }.await;
    if accepted.is_err() {
        drop(action_guard);
        drop(guard);
        let _ = actions::cancel(state, store, id, "原预授权已变化，此次操作未自动执行。").await;
        accepted?;
        return Err(data::conflict());
    }
    actions::persist(store, &saved).await?;
    let job = state
        .apps
        .jobs
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(data::conflict)?;
    super::action_execution::start(state, job, id, approval)?;
    drop(action_guard);
    drop(guard);
    actions::wait(state, store, id, authorize).await.map(Some)
}
