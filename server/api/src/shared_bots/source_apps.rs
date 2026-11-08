use super::{
    resources,
    source::{SourceDatabase, Workspace},
    store::{sha, unavailable, uuid},
};
use crate::{
    apps::tool_access,
    db::State,
    error::{ApiError, Result, only_fields},
};
use serde_json::{Value, json};
use sqlx::{Row, sqlite::SqliteRow};

const CONTROLS_PROJECTION: &str = "CASE WHEN json_type(data,'$.toolControls') IS NULL THEN NULL WHEN json_type(data,'$.toolControls')='object' AND length(CAST(json_extract(data,'$.toolControls') AS BLOB))<=131072 THEN json_extract(data,'$.toolControls') ELSE 'null' END AS controls";

fn controls(row: &SqliteRow) -> Result<Option<Value>> {
    row.try_get::<Option<String>, _>("controls")
        .map_err(|_| fail())?
        .map(|raw| serde_json::from_str(&raw).map_err(|_| fail()))
        .transpose()
}
fn fail() -> ApiError {
    ApiError::new(409, "来源应用或工具已变化，请由拥有者重新确认授权版本。")
        .with_code("SHARED_APP_CHANGED")
}
pub(crate) async fn inspect(state: &State, workspace: &Workspace, id: &str) -> Result<Value> {
    if !uuid(id) {
        return Err(ApiError::bad("应用标识无效。"));
    }
    let mut db = SourceDatabase::open(state, workspace).await?;
    if !db.exists("app_connections").await? {
        return Err(fail());
    }
    let row=sqlx::query(&format!("SELECT json_extract(data,'$.id') AS stored_id,json_extract(data,'$.name') AS name,json_extract(data,'$.status') AS status,json_extract(data,'$.revision') AS revision,CASE WHEN length(CAST(json_extract(data,'$.tools') AS BLOB))<=524288 THEN json_extract(data,'$.tools') ELSE NULL END AS tools,{CONTROLS_PROJECTION} FROM app_connections WHERE id=?")).bind(id).fetch_optional(&mut db.conn).await?.ok_or_else(fail)?;
    let name: String = row.try_get("name").map_err(|_| fail())?;
    let revision: String = row.try_get("revision").map_err(|_| fail())?;
    if row.try_get::<String, _>("stored_id").ok().as_deref() != Some(id)
        || row.try_get::<String, _>("status").ok().as_deref() != Some("connected")
        || !uuid(&revision)
        || !resources::safe_name(&json!(name), 80)
    {
        return Err(fail());
    }
    let raw: String = row.try_get("tools").map_err(|_| fail())?;
    let raw_value: Value = serde_json::from_str(&raw).map_err(|_| fail())?;
    let array = raw_value
        .as_array()
        .filter(|v| v.len() <= 64)
        .ok_or_else(fail)?;
    let mut tools = Vec::new();
    let mut names = std::collections::HashSet::new();
    let controls = controls(&row)?;
    for (index, tool) in array.iter().enumerate() {
        if !resources::tool_name(&tool["name"])
            || !tool["description"]
                .as_str()
                .is_some_and(|v| v.encode_utf16().count() <= 4000)
            || !tool["inputSchema"].is_object()
            || tool["inputSchema"]["type"] != "object"
            || !names.insert(tool["name"].clone().to_string())
        {
            return Err(fail());
        }
        let (enabled, access_revision) =
            tool_access::read(controls.as_ref(), tool["name"].as_str().unwrap());
        if !enabled {
            continue;
        }
        validate_schema(&tool["inputSchema"], 0)?;
        let schema: String = sqlx::query_scalar("SELECT json_extract(?,?)")
            .bind(&raw)
            .bind(format!("$[{index}].inputSchema"))
            .fetch_one(&mut db.conn)
            .await?;
        if schema.len() > 16384 {
            return Err(fail());
        }
        let revision = tool_revision_with_schema(tool, &schema)?;
        let revision = match access_revision {
            Some(access) => sha(json!([revision, access]).to_string()),
            None => revision,
        };
        tools.push(json!({"name":tool["name"],"description":tool["description"],"inputSchema":tool["inputSchema"],"revision":revision}));
    }
    db.check()?;
    Ok(json!({"connectionId":id,"name":name,"connectionRevision":revision,"tools":tools}))
}
fn validate_schema(value: &Value, depth: usize) -> Result<()> {
    if depth > 20 {
        return Err(fail());
    }
    if let Some(object) = value.as_object() {
        for (key, value) in object {
            if ["__proto__", "prototype", "constructor"].contains(&key.as_str()) {
                return Err(fail());
            }
            validate_schema(value, depth + 1)?;
        }
    }
    if let Some(array) = value.as_array() {
        for v in array {
            validate_schema(v, depth + 1)?;
        }
    }
    Ok(())
}
pub(crate) async fn selected_tools(
    state: &State,
    workspace: &Workspace,
    grant: &Value,
) -> Result<Vec<Value>> {
    matching_tools(state, workspace, grant, true).await
}

pub(crate) async fn available_tools(
    state: &State,
    workspace: &Workspace,
    grant: &Value,
) -> Result<Vec<Value>> {
    matching_tools(state, workspace, grant, false).await
}

async fn matching_tools(
    state: &State,
    workspace: &Workspace,
    grant: &Value,
    strict: bool,
) -> Result<Vec<Value>> {
    let catalog = inspect(
        state,
        workspace,
        grant["connectionId"].as_str().unwrap_or(""),
    )
    .await?;
    if catalog["connectionRevision"] != grant["connectionRevision"]
        || catalog["name"] != grant["name"]
    {
        return Err(fail());
    }
    let mut result = Vec::new();
    for selected in grant["tools"].as_array().ok_or_else(fail)? {
        let current = catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == selected["name"] && t["revision"] == selected["revision"]);
        match current {
            Some(tool) => result.push(tool.clone()),
            None if strict => return Err(fail()),
            None => {}
        }
    }
    if result.is_empty() {
        return Err(fail());
    }
    Ok(result)
}

pub(crate) async fn available_selection(
    state: &State,
    workspace: &Workspace,
    grant: &Value,
) -> Result<Value> {
    let tools = available_tools(state, workspace, grant).await?;
    let mut selection = grant.clone();
    selection["tools"] = json!(
        tools
            .iter()
            .map(|tool| { json!({"name":tool["name"],"revision":tool["revision"]}) })
            .collect::<Vec<_>>()
    );
    Ok(selection)
}
pub(crate) async fn select(
    state: &State,
    workspace: &Workspace,
    input: Option<&Value>,
    old: Option<&Vec<Value>>,
) -> Result<Option<Vec<Value>>> {
    let Some(input) = input else {
        return Ok(old.cloned());
    };
    let entries = input
        .as_array()
        .filter(|v| v.len() <= 20)
        .ok_or_else(|| ApiError::bad("最多选择20个来源应用。"))?;
    let mut ids = std::collections::HashSet::new();
    let mut result = Vec::new();
    let mut bytes = 0;
    for selected in entries {
        only_fields(selected, &["connectionId", "connectionRevision", "tools"])?;
        let id = selected["connectionId"]
            .as_str()
            .filter(|v| uuid(v))
            .ok_or_else(|| ApiError::bad("应用标识无效。"))?;
        if !ids.insert(id) || !selected["connectionRevision"].as_str().is_some_and(uuid) {
            return Err(ApiError::bad("应用标识或版本无效。"));
        }
        let catalog = inspect(state, workspace, id).await?;
        let mut grant = selected.clone();
        grant["name"] = catalog["name"].clone();
        let tools = selected_tools(state, workspace, &grant).await?;
        if tools.is_empty() || tools.len() > 64 {
            return Err(ApiError::bad("请选择需要授权的工具。"));
        }
        bytes += serde_json::to_vec(&tools).unwrap().len();
        if bytes > 512 * 1024 {
            return Err(ApiError::new(413, "已选择的工具资料过多。"));
        }
        for tool in selected["tools"].as_array().unwrap() {
            only_fields(tool, &["name", "revision"])?;
        }
        result.push(grant);
    }
    result.sort_by(|a, b| a["connectionId"].as_str().cmp(&b["connectionId"].as_str()));
    Ok(Some(result))
}
pub(crate) async fn views(state: &State, workspace: &Workspace, grants: &[Value]) -> Vec<Value> {
    let mut result = Vec::new();
    for grant in grants {
        let view = match available_selection(state, workspace, grant).await {
            Ok(mut selection) => {
                selection["status"] = json!("available");
                selection
            }
            Err(_) => {
                let mut selection = grant.clone();
                selection["tools"] = json!([]);
                selection["status"] = json!("changed");
                selection["reason"] = json!("来源应用或工具已变化，等待拥有者重新确认。");
                selection
            }
        };
        result.push(view);
    }
    result
}
pub(crate) async fn options(
    state: &State,
    workspace: &Workspace,
    grants: &[Value],
) -> Result<Value> {
    let mut db = SourceDatabase::open(state, workspace).await?;
    let mut apps = Vec::new();
    if db.exists("app_connections").await? {
        let rows=sqlx::query(&format!("SELECT id,json_extract(data,'$.id') AS stored_id,json_extract(data,'$.name') AS name,json_extract(data,'$.status') AS status,json_array_length(data,'$.tools') AS tool_count,CASE WHEN json_array_length(data,'$.tools')<=64 AND length(CAST(json_extract(data,'$.tools') AS BLOB))<=524288 THEN (SELECT json_group_array(json_extract(value,'$.name')) FROM json_each(data,'$.tools')) END AS tool_names,{CONTROLS_PROJECTION} FROM app_connections ORDER BY rowid LIMIT 21")).fetch_all(&mut db.conn).await?;
        if rows.len() > 20 {
            return Err(fail());
        }
        for row in rows {
            let id: String = row.get("id");
            let name: String = row.try_get("name").map_err(|_| unavailable())?;
            let status: String = row.try_get("status").map_err(|_| unavailable())?;
            let count: i64 = row.try_get("tool_count").map_err(|_| unavailable())?;
            if !uuid(&id)
                || row.try_get::<String, _>("stored_id").ok() != Some(id.clone())
                || !resources::safe_name(&json!(name), 80)
                || !["connected", "disconnected", "needs_auth", "error"].contains(&status.as_str())
                || !(0..=64).contains(&count)
            {
                return Err(fail());
            }
            let names: String = row.try_get("tool_names").map_err(|_| fail())?;
            let names: Vec<String> = serde_json::from_str(&names).map_err(|_| fail())?;
            let controls = controls(&row)?;
            let count = names
                .iter()
                .filter(|name| tool_access::read(controls.as_ref(), name).0)
                .count();
            apps.push(json!({"connectionId":id,"name":name,"status":status,"toolCount":count}));
        }
    }
    db.check()?;
    Ok(json!({"apps":apps,"selected":views(state,workspace,grants).await}))
}

pub fn tool_revision(tool: &Value) -> Result<String> {
    tool_revision_with_schema(
        tool,
        &serde_json::to_string(&tool["inputSchema"]).map_err(|_| fail())?,
    )
}
pub fn tool_revision_with_schema(tool: &Value, schema: &str) -> Result<String> {
    if !resources::tool_name(&tool["name"])
        || !tool["description"].is_string()
        || serde_json::from_str::<Value>(schema).ok().as_ref() != Some(&tool["inputSchema"])
    {
        return Err(fail());
    }
    Ok(sha(format!(
        "{{\"name\":{},\"description\":{},\"inputSchema\":{}}}",
        serde_json::to_string(&tool["name"]).unwrap(),
        serde_json::to_string(&tool["description"]).unwrap(),
        schema
    )))
}
pub(crate) async fn state_revision(
    state: &State,
    workspace: &Workspace,
    grants: &[Value],
    revision: &str,
) -> String {
    let mut states = Vec::new();
    for grant in grants {
        let state = match inspect(
            state,
            workspace,
            grant["connectionId"].as_str().unwrap_or(""),
        )
        .await
        {
            Ok(catalog) => json!([
                grant["connectionId"],
                catalog["connectionRevision"],
                catalog["tools"]
            ]),
            Err(error) => json!([grant["connectionId"], error.code]),
        };
        states.push(state);
    }
    sha(serde_json::to_vec(&json!([revision, states])).unwrap())
}
