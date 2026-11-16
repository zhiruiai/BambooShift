use crate::{
    db::State,
    error::{ApiError, Result, only_fields},
    workspace::{access, starter_skills},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    sync::LazyLock,
};

static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../shared/team-starter-templates.json"
    ))
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

type StarterPacks = BTreeMap<String, Vec<starter_skills::Pack>>;
const STOCK_FIELDS: &[&str] = &[
    "key",
    "kind",
    "name",
    "role",
    "description",
    "instructions",
    "avatar",
    "color",
    "assignment",
    "avatarImageId",
    "modelProfileId",
];

fn matching_packs(saved: &Value, draft: &Value) -> Result<StarterPacks> {
    let mut result = BTreeMap::new();
    let Some(stock) = saved["starterMembers"].as_array() else {
        return Ok(result);
    };
    let invalid = || ApiError::new(409, "内置团队来源已变化，请重新打开模板。");
    let id = saved["template"]["id"].as_str().ok_or_else(invalid)?;
    let language = saved["template"]["language"].as_str().ok_or_else(invalid)?;
    let members = draft["members"].as_array().ok_or_else(invalid)?;
    for member in members {
        if member["kind"] == "create"
            && stock.iter().any(|original| {
                STOCK_FIELDS
                    .iter()
                    .all(|&field| member[field] == original[field])
            })
        {
            let key = member["key"].as_str().ok_or_else(invalid)?;
            result.insert(key.to_owned(), starter_skills::team(id, key, language)?);
        }
    }
    Ok(result)
}

pub fn summaries(packs: &StarterPacks) -> Value {
    json!(
        packs
            .iter()
            .map(|(key, packs)| {
                (
                    key,
                    packs
                        .iter()
                        .map(starter_skills::Pack::summary)
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<BTreeMap<_, _>>()
    )
}

fn fingerprint(packs: &[starter_skills::Pack]) -> Value {
    json!(
        packs
            .iter()
            .map(starter_skills::Pack::fingerprint)
            .collect::<Vec<_>>()
    )
}

pub fn review_skills(saved: &mut Value) -> Result<()> {
    if !saved["starterMembers"].is_array() {
        return Ok(());
    }
    let packs = matching_packs(saved, &saved["plan"]["draft"])?;
    saved["plan"]["starterSkills"] = summaries(&packs);
    saved["starterSkillFingerprints"] = json!(
        packs
            .iter()
            .map(|(key, packs)| { (key, fingerprint(packs)) })
            .collect::<BTreeMap<_, _>>()
    );
    Ok(())
}

pub fn reviewed_packs(saved: &Value, draft: &Value) -> Result<StarterPacks> {
    let mut packs = matching_packs(saved, draft)?;
    packs.retain(|key, _| saved["plan"]["starterSkills"].get(key).is_some());
    if packs
        .iter()
        .any(|(key, packs)| saved["starterSkillFingerprints"][key] != fingerprint(packs))
    {
        return Err(
            ApiError::new(409, "内置技能包已更新，请先保存草案并核对技能。")
                .with_code("STARTER_SKILL_PLAN_CHANGED"),
        );
    }
    Ok(packs)
}
