use super::{Table, WorkspaceAccess, WorkspaceStore, access, knowledge, mutations};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields, text},
};
use axum::{
    Json, Router,
    extract::{Path, State as Extract},
    http::HeaderMap,
    routing::{get, put},
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::collections::BTreeMap;

pub(super) fn router() -> Router<State> {
    Router::new()
        .route("/api/workspaces/{wid}/private-skills", get(list))
        .route(
            "/api/workspaces/{wid}/private-skills/{id}/bots/{target}",
            put(assign),
        )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Shelf {
    agents: Vec<Bot>,
    skills: Vec<Entry>,
}

#[derive(Clone, Serialize)]
struct Bot {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    id: String,
    pub(super) source_agent_id: String,
    source_agent_name: String,
    pub(super) name: String,
    pub(super) description: String,
    pub(super) content: String,
    pub(super) version: u64,
    pub(super) revision: String,
    available: bool,
    enabled_agent_ids: Vec<String>,
}

impl Entry {
    fn original(skill: &Value, bots: &BTreeMap<String, Bot>) -> Option<Self> {
        if skill["status"] != "active"
            || skill.get("privateSource").is_some()
            || skill.get("teamSource").is_some()
        {
            return None;
        }
        let bot = bots.get(skill["agentId"].as_str()?)?;
        let description = skill["description"].as_str().unwrap_or("");
        if description.encode_utf16().count() > 1000 {
            return None;
        }
        let mut entry = Self {
            id: skill["id"].as_str()?.into(),
            source_agent_id: bot.id.clone(),
            source_agent_name: bot.name.clone(),
            name: text(&skill["name"], "技能名称", 100).ok()?,
            description: description.into(),
            content: text(&skill["content"], "技能内容", 16000).ok()?,
            version: skill["version"]
                .as_u64()
                .filter(|version| *version > 0)
                .unwrap_or(1),
            revision: String::new(),
            available: true,
            enabled_agent_ids: Vec::new(),
        };
        entry.revision = entry.digest();
        Some(entry)
    }

    fn pinned(skill: &Value, bots: &BTreeMap<String, Bot>) -> Option<Self> {
        if skill.get("teamSource").is_some() {
            return None;
        }
        let owner = bots.get(skill["agentId"].as_str()?)?;
        let source = &skill["privateSource"];
        let source_agent_id = source["agentId"].as_str()?;
        if owner.id == source_agent_id {
            return None;
        }
        let entry = Self {
            id: source["skillId"].as_str()?.into(),
            source_agent_id: source_agent_id.into(),
            source_agent_name: bots
                .get(source_agent_id)
                .map(|bot| bot.name.as_str())
                .or_else(|| source["agentName"].as_str())?
                .into(),
            name: skill["name"].as_str()?.into(),
            description: skill["description"].as_str().unwrap_or("").into(),
            content: skill["content"].as_str()?.into(),
            version: source["version"].as_u64()?,
            revision: source["revision"].as_str()?.into(),
            available: false,
            enabled_agent_ids: vec![owner.id.clone()],
        };
        (entry.digest() == entry.revision).then_some(entry)
    }

    fn digest(&self) -> String {
        let reviewed = json!([
            self.id,
            self.source_agent_id,
            self.name,
            self.description,
            self.content,
            self.version
        ]);
        hex::encode(Sha256::digest(reviewed.to_string()))
    }

    fn key(&self) -> (String, String) {
        (self.id.clone(), self.revision.clone())
    }

    fn provenance(&self) -> Value {
        json!({"skillId":self.id,"agentId":self.source_agent_id,"agentName":self.source_agent_name,
            "version":self.version,"revision":self.revision})
    }
}

fn local_bots(values: Vec<Value>) -> BTreeMap<String, Bot> {
    values
        .into_iter()
        .filter_map(|value| {
            mutations::local(&value).ok()?;
            let id = value["id"].as_str()?.to_owned();
            Some((
                id.clone(),
                Bot {
                    id,
                    name: value["name"].as_str()?.to_owned(),
                },
            ))
        })
        .collect()
}

fn changed() -> ApiError {
    ApiError::new(409, "私有技能或目标 Bot 已变化，请刷新并重新核对。")
        .with_code("PRIVATE_SKILL_CHANGED")
}

pub(super) async fn require(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
) -> Result<WorkspaceAccess> {
    let actor = access::require(state, headers, wid, true, true).await?;
    if actor.kind != "personal" {
        return Err(ApiError::new(403, "只能在自己拥有的个人空间管理私有技能。"));
    }
    Ok(actor)
}

pub(super) async fn review_in(conn: &mut SqliteConnection, id: &str) -> Result<Option<Entry>> {
    let Some(skill) = WorkspaceStore::get_in(conn, Table::Skills, id).await? else {
        return Ok(None);
    };
    let Some(agent_id) = skill["agentId"].as_str() else {
        return Ok(None);
    };
    let Some(agent) = WorkspaceStore::get_in(conn, Table::Agents, agent_id).await? else {
        return Ok(None);
    };
    Ok(Entry::original(&skill, &local_bots(vec![agent])))
}

async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Shelf>> {
    let actor = require(&state, &headers, &wid).await?;
    let store = actor.store(&state).await?;
    let mut tx = store.pool.begin().await?;
    let bots = local_bots(WorkspaceStore::list_in(&mut tx, Table::Agents).await?);
    let skills = WorkspaceStore::list_in(&mut tx, Table::Skills).await?;
    tx.commit().await?;
    let mut entries: BTreeMap<_, _> = skills
        .iter()
        .filter_map(|skill| Entry::original(skill, &bots))
        .map(|entry| (entry.key(), entry))
        .collect();
    for pinned in skills
        .iter()
        .filter(|skill| skill["status"] == "active")
        .filter_map(|skill| Entry::pinned(skill, &bots))
    {
        if let Some(entry) = entries.get_mut(&pinned.key()) {
            entry.enabled_agent_ids.extend(pinned.enabled_agent_ids);
        } else {
            entries.insert(pinned.key(), pinned);
        }
    }
    let mut skills: Vec<_> = entries.into_values().collect();
    for entry in &mut skills {
        entry.enabled_agent_ids.sort();
        entry.enabled_agent_ids.dedup();
    }
    skills.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.source_agent_name.cmp(&b.source_agent_name))
            .then_with(|| b.available.cmp(&a.available))
            .then_with(|| b.version.cmp(&a.version))
    });
    let mut agents: Vec<_> = bots.into_values().collect();
    agents.sort_by(|a, b| a.name.cmp(&b.name));
    actor.authorize_owner(&state).await?;
    Ok(Json(Shelf { agents, skills }))
}

fn input(body: &Value) -> Result<(bool, &str)> {
    only_fields(body, &["enabled", "expectedRevision"])?;
    body["enabled"]
        .as_bool()
        .zip(body["expectedRevision"].as_str().filter(|revision| {
            revision.len() == 64
                && revision
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }))
        .ok_or_else(|| ApiError::bad("私有技能设置无效。"))
}

async fn assign(
    Extract(state): Extract<State>,
    Path((wid, id, target)): Path<(String, String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = require(&state, &headers, &wid).await?;
    let (enabled, expected) = input(&body)?;
    let store = actor.store(&state).await?;
    let mut tx = store.begin().await?;
    let bots = local_bots(WorkspaceStore::list_in(&mut tx, Table::Agents).await?);
    if !bots.contains_key(&target) {
        return Err(changed());
    }
    let skills = WorkspaceStore::list_in(&mut tx, Table::Skills).await?;
    let active = skills
        .iter()
        .filter(|skill| skill["agentId"] == target && skill["status"] == "active");
    let linked: Vec<_> = active
        .clone()
        .filter(|skill| skill["privateSource"]["skillId"] == id)
        .collect();
    if linked
        .iter()
        .any(|skill| Entry::pinned(skill, &bots).is_none_or(|entry| entry.revision != expected))
    {
        return Err(changed());
    }
    let mut modified = false;
    if enabled {
        let source = skills
            .iter()
            .find(|skill| skill["id"] == id)
            .and_then(|skill| Entry::original(skill, &bots))
            .filter(|entry| entry.revision == expected && entry.source_agent_id != target)
            .ok_or_else(changed)?;
        if linked.is_empty() {
            if active.clone().any(|skill| {
                skill["name"]
                    .as_str()
                    .is_some_and(|name| name.trim() == source.name)
            }) {
                return Err(ApiError::new(
                    409,
                    "目标 Bot 已启用同名技能，请先在该 Bot 的技能设置中处理。",
                )
                .with_code("PRIVATE_SKILL_NAME_CONFLICT"));
            }
            let stamp = iso(now());
            let prior = skills.iter().rev().find(|skill| {
                skill["agentId"] == target
                    && ["disabled", "archived"].contains(&skill["status"].as_str().unwrap_or(""))
                    && skill["privateSource"]["skillId"] == id
                    && Entry::pinned(skill, &bots).is_some_and(|entry| entry.revision == expected)
            });
            let mut skill = if let Some(prior) = prior {
                let mut prior = prior.clone();
                if let Some(record) = prior.as_object_mut() {
                    record.remove("deactivatedAt");
                }
                prior
            } else {
                let body = json!({"agentId":target,"name":source.name,"description":source.description,"content":source.content});
                let mut skill = knowledge::stage_skill(&mut tx, &body, None).await?;
                skill["approvedAt"] = json!(stamp);
                skill["privateSource"] = source.provenance();
                skill
            };
            skill["status"] = json!("active");
            skill["activatedAt"] = json!(stamp);
            WorkspaceStore::put_in(&mut tx, Table::Skills, &skill).await?;
            modified = true;
        }
    } else {
        let stamp = iso(now());
        for skill in linked {
            let mut skill = skill.clone();
            skill["status"] = json!("disabled");
            skill["deactivatedAt"] = json!(stamp);
            WorkspaceStore::put_in(&mut tx, Table::Skills, &skill).await?;
            modified = true;
        }
    }
    actor.authorize_owner(&state).await?;
    tx.commit().await?;
    if modified {
        store.emit("update", json!({}));
    }
    Ok(Json(json!({"enabled":enabled})))
}
