use super::{
    resources,
    store::{opaque, sha, uuid},
};
use crate::error::{ApiError, Result, only_fields};
use serde_json::{Value, json};
pub(crate) fn digest(wid: &str, agent: &str, body: &Value, revoke: bool) -> Result<String> {
    if revoke {
        return Ok(sha(serde_json::to_vec(&json!([
            "revoke",
            wid,
            agent,
            body["expectedRevision"]
        ]))
        .unwrap()));
    }
    let team = body["targetTeamId"]
        .as_str()
        .filter(|v| uuid(v))
        .ok_or_else(invalid)?;
    let audience = body["audience"]
        .as_str()
        .filter(|v| ["team", "selected"].contains(v))
        .ok_or_else(invalid)?;
    let raw = body["memberIds"]
        .as_array()
        .filter(|v| v.len() <= 200)
        .ok_or_else(invalid)?;
    let mut members = Vec::new();
    for v in raw {
        let id = v.as_str().filter(|v| opaque(v)).ok_or_else(invalid)?;
        if members.contains(&id) {
            return Err(invalid());
        }
        members.push(id);
    }
    if (audience == "team" && !members.is_empty()) || (audience == "selected" && members.is_empty())
    {
        return Err(invalid());
    }
    members.sort();
    let mut fields = vec![
        json!("update"),
        json!(wid),
        json!(agent),
        body["expectedRevision"].clone(),
        json!(team),
        json!(audience),
        json!(members),
    ];
    if let Some(files) = body.get("files") {
        let files = files
            .as_array()
            .filter(|v| v.len() <= 32)
            .ok_or_else(invalid)?;
        let mut result = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for file in files {
            only_fields(file, &["fileId", "revision"])?;
            if !file["fileId"].as_str().is_some_and(opaque)
                || !resources::revision(&file["revision"])
                || !ids.insert(file["fileId"].to_string())
            {
                return Err(invalid());
            }
            result.push(file.clone());
        }
        result.sort_by(|a, b| a["fileId"].as_str().cmp(&b["fileId"].as_str()));
        fields.push(json!(result));
    }
    if let Some(apps) = body.get("apps") {
        let apps = apps
            .as_array()
            .filter(|v| v.len() <= 20)
            .ok_or_else(invalid)?;
        let mut result = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for app in apps {
            only_fields(app, &["connectionId", "connectionRevision", "tools"])?;
            if !app["connectionId"].as_str().is_some_and(uuid)
                || !app["connectionRevision"].as_str().is_some_and(uuid)
                || !ids.insert(app["connectionId"].to_string())
            {
                return Err(invalid());
            }
            let tools = app["tools"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 64)
                .ok_or_else(invalid)?;
            let mut checked = Vec::new();
            let mut names = std::collections::HashSet::new();
            for tool in tools {
                only_fields(tool, &["name", "revision"])?;
                if !resources::tool_name(&tool["name"])
                    || !resources::revision(&tool["revision"])
                    || !names.insert(tool["name"].to_string())
                {
                    return Err(invalid());
                }
                checked.push(tool.clone());
            }
            checked.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            result.push(json!({"connectionId":app["connectionId"],"connectionRevision":app["connectionRevision"],"tools":checked}));
        }
        result.sort_by(|a, b| a["connectionId"].as_str().cmp(&b["connectionId"].as_str()));
        fields.push(json!({"apps":result}));
    }
    Ok(sha(serde_json::to_vec(&fields).unwrap()))
}
fn invalid() -> ApiError {
    ApiError::bad("请选择有效且不重复的共享范围、成员和授权版本。").with_code("SHARED_BOT_INVALID")
}
