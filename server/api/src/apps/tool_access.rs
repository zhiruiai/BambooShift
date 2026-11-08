use super::{
    Authority, actions,
    model::{self, Connection, PreparedCall},
    policy_data, store,
};
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::WorkspaceStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

const MAX_CONTROLLED_TOOLS: usize = 512;

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Control {
    enabled: bool,
    revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    tool_name: String,
    enabled: bool,
    expected_connection_revision: String,
    expected_tool_revision: String,
}

pub(crate) fn enabled(connection: &Connection, tool: &str) -> bool {
    connection
        .tool_controls
        .get(tool)
        .is_none_or(|entry| entry.enabled && !entry.revision.is_empty())
}

pub(crate) fn revision<'a>(connection: &'a Connection, tool: &str) -> Option<&'a str> {
    connection
        .tool_controls
        .get(tool)
        .map(|entry| entry.revision.as_str())
}

pub(crate) fn current(connection: &Connection, tool: &str, expected: Option<&str>) -> bool {
    enabled(connection, tool) && revision(connection, tool) == expected
}

pub(crate) fn read<'a>(controls: Option<&'a Value>, name: &str) -> (bool, Option<&'a str>) {
    let Some(controls) = controls else {
        return (true, None);
    };
    let Some(entries) = controls.as_object() else {
        return (false, None);
    };
    let Some(control) = entries.get(name) else {
        return (true, None);
    };
    let revision = control["revision"]
        .as_str()
        .filter(|value| !value.is_empty());
    (control["enabled"] == true && revision.is_some(), revision)
}

pub(crate) fn filter(connection: &Connection) -> Vec<Value> {
    connection
        .tools
        .iter()
        .filter(|tool| {
            tool["name"]
                .as_str()
                .is_some_and(|name| enabled(connection, name))
        })
        .cloned()
        .collect()
}

pub(super) fn changed() -> ApiError {
    ApiError::new(409, "应用工具权限已变化，请刷新后重新核对。")
        .with_code("APP_TOOL_ACCESS_CHANGED")
}

pub(super) fn disabled() -> ApiError {
    ApiError::new(403, "此应用工具已由工作空间所有者停用。").with_code("APP_TOOL_DISABLED")
}

pub(super) fn project(connection: &Connection, tool: &Value) -> Value {
    let name = tool["name"].as_str().unwrap_or_default();
    let mut public = tool.clone();
    public["access"] = json!({
        "enabled": enabled(connection, name),
        "revision": model::hash(&json!([tool, revision(connection, name)])),
    });
    public
}

pub(super) async fn check_call(store: &WorkspaceStore, call: &PreparedCall) -> Result<()> {
    let connection = store::connection(store, &call.connection_id).await?;
    if store.is_closed()
        || connection.status != "connected"
        || connection.revision != call.connection_revision
        || !current(
            &connection,
            &call.tool_name,
            call.tool_access_revision.as_deref(),
        )
    {
        return Err(changed());
    }
    Ok(())
}

pub(super) fn call_authority(
    store: Arc<WorkspaceStore>,
    call: &PreparedCall,
    authorize: Authority,
) -> Authority {
    let call = Arc::new(call.clone());
    Arc::new(move || {
        let (store, call, authorize) = (store.clone(), call.clone(), authorize.clone());
        Box::pin(async move {
            authorize().await?;
            check_call(&store, &call).await
        })
    })
}

pub(super) async fn update(
    state: &State,
    store: &Arc<WorkspaceStore>,
    id: &str,
    body: Value,
    authorize: Authority,
) -> Result<Value> {
    let request: Update =
        serde_json::from_value(body).map_err(|_| ApiError::bad("应用工具权限设置无效。"))?;
    if request.tool_name.is_empty()
        || request.tool_name.len() > 128
        || request.expected_connection_revision.len() > 160
        || request.expected_tool_revision.len() != 64
    {
        return Err(ApiError::bad("应用工具权限设置无效。"));
    }
    let lock = state
        .apps
        .lock(&format!("{}:{id}", store.workspace_id))
        .await;
    let guard = lock.lock().await;
    state.apps.active()?;
    authorize().await?;
    let mut tx = store.begin().await?;
    let mut connection = store::connection_in(&mut tx, id)
        .await?
        .ok_or_else(changed)?;
    if connection.status != "connected"
        || connection.revision != request.expected_connection_revision
    {
        return Err(changed());
    }
    let name = &request.tool_name;
    let tool = connection
        .tools
        .iter()
        .find(|tool| tool["name"] == *name)
        .ok_or_else(changed)?
        .clone();
    let before = project(&connection, &tool);
    if before["access"]["revision"] != request.expected_tool_revision {
        return Err(changed());
    }
    if enabled(&connection, name) == request.enabled {
        authorize().await?;
        return Ok(before);
    }
    let previous = revision(&connection, name).map(str::to_owned);
    if previous.is_none() && connection.tool_controls.len() >= MAX_CONTROLLED_TOOLS {
        return Err(
            ApiError::new(409, "此连接已达到工具权限记录上限。").with_code("APP_TOOL_ACCESS_LIMIT")
        );
    }
    connection.tool_controls.insert(
        name.clone(),
        Control {
            enabled: request.enabled,
            revision: Uuid::new_v4().to_string(),
        },
    );
    sqlx::query(
        "UPDATE app_connections SET data=json_set(data,'$.toolControls',json(?)) WHERE id=?",
    )
    .bind(json!(connection.tool_controls).to_string())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    policy_data::invalidate_tool(&mut tx, id, name).await?;
    authorize().await?;
    state.apps.active()?;
    tx.commit().await?;
    drop(guard);
    state.changed(None, None, None);
    store.emit("update", json!({}));
    state.workspace.emit_all("update", json!({})).await;
    actions::cancel_tool(state, &store.workspace_id, id, name, previous.as_deref()).await;
    Ok(project(&connection, &tool))
}
