use crate::{
    db::State,
    error::{ApiError, Result, only_fields},
    workspace::access,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::LazyLock};

static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../shared/team-starter-templates.json"))
        .expect("The checked-in team catalog is valid")
});

pub async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let language = if crate::error_locale::english(&headers) {
        "en"
    } else {
        "zh-CN"
    };
    grant.authorize_owner(&state).await?;
    Ok(Json(CATALOG[language].clone()))
}

pub fn selected(value: &Value) -> Result<Value> {
    only_fields(value, &["id", "language"])?;
    let invalid = || ApiError::bad("团队模板无效。").with_code("INVALID_TEAM_TEMPLATE");
    let language = value["language"].as_str().ok_or_else(invalid)?;
    let id = value["id"].as_str().ok_or_else(invalid)?;
    let templates = CATALOG[language].as_array().ok_or_else(invalid)?;
    templates
        .iter()
        .find(|item| item["id"] == id)
        .map(|item| item["draft"].clone())
        .ok_or_else(invalid)
}

pub fn unique_names(draft: &mut Value, agents: &[Value]) {
    let mut names: HashSet<String> = agents
        .iter()
        .filter_map(|agent| agent["name"].as_str().map(str::to_lowercase))
        .collect();
    for member in draft["members"].as_array_mut().unwrap() {
        let original = member["name"].as_str().unwrap();
        let mut name = original.to_owned();
        let mut next = 2;
        while !names.insert(name.to_lowercase()) {
            name = format!("{original} {next}");
            next += 1;
        }
        member["name"] = json!(name);
    }
}
