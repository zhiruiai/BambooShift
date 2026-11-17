use super::knowledge;
use crate::error::{ApiError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::{collections::HashSet, sync::LazyLock};

static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../shared/starter-skill-packs.json"))
        .expect("The checked-in starter skill catalog is valid JSON")
});

fn unavailable() -> ApiError {
    ApiError::new(500, "内置技能包暂不可用。").with_code("STARTER_SKILL_UNAVAILABLE")
}

pub(crate) struct Pack {
    id: &'static str,
    text: &'static Value,
    artifact_path: &'static str,
    artifact_content: &'static str,
    chinese: bool,
    workflow: bool,
}

impl Pack {
    pub(crate) fn summary(&self) -> Value {
        json!({"id":self.id,"name":self.text["name"],"description":self.text["description"]})
    }

    pub(crate) fn fingerprint(&self) -> String {
        if self.workflow {
            let body = super::workflow_skills::package(
                self.id,
                if self.chinese { "zh-CN" } else { "en" },
                &Value::Null,
            )
            .expect("checked-in workflow package");
            return hex::encode(Sha256::digest(body.to_string()));
        }
        hex::encode(Sha256::digest(
            json!([
                2,
                self.id,
                self.text,
                self.artifact_path,
                self.artifact_content
            ])
            .to_string(),
        ))
    }
}

fn selected(entry: &'static Value, language: &str) -> Result<Vec<Pack>> {
    let mut seen = HashSet::new();
    entry
        .as_array()
        .filter(|ids| !ids.is_empty())
        .ok_or_else(unavailable)?
        .iter()
        .map(|entry| {
            let id = entry
                .as_str()
                .filter(|id| seen.insert(*id))
                .ok_or_else(unavailable)?;
            let pack = &CATALOG["packs"][id];
            if pack.is_null() {
                let text = super::workflow_skills::recipe(id, language).ok_or_else(unavailable)?;
                return Ok(Pack {
                    id,
                    text,
                    artifact_path: "",
                    artifact_content: "",
                    chinese: language == "zh-CN",
                    workflow: true,
                });
            }
            let text = &pack["locales"][language];
            if !text["name"].is_string()
                || !text["description"].is_string()
                || !text["instructions"].is_string()
                || text["checklist"].as_array().is_none_or(Vec::is_empty)
            {
                return Err(unavailable());
            }
            Ok(Pack {
                id,
                text,
                artifact_path: pack["artifact"]["path"].as_str().ok_or_else(unavailable)?,
                artifact_content: pack["artifact"]["content"]
                    .as_str()
                    .ok_or_else(unavailable)?,
                chinese: language == "zh-CN",
                workflow: false,
            })
        })
        .collect()
}

pub(super) fn bot(id: &str, language: &str) -> Result<Vec<Pack>> {
    selected(&CATALOG["bots"][id], language)
}

pub(crate) fn team(id: &str, key: &str, language: &str) -> Result<Vec<Pack>> {
    selected(&CATALOG["teams"][id][key], language)
}

pub(crate) async fn install(
    conn: &mut SqliteConnection,
    packs: &[Pack],
    agent_id: &Value,
) -> Result<Vec<Value>> {
    let mut installed = Vec::with_capacity(packs.len());
    for pack in packs {
        if pack.workflow {
            let body = super::workflow_skills::package(
                pack.id,
                if pack.chinese { "zh-CN" } else { "en" },
                agent_id,
            )?;
            installed.push(super::workflow_skills::install(conn, &body).await?);
            continue;
        }
        let title = pack.text["name"].as_str().ok_or_else(unavailable)?;
        let instructions = pack.text["instructions"].as_str().ok_or_else(unavailable)?;
        let (direction, section) = if pack.chinese {
            (
                "交付前核对[检查清单](references/checklist.md)，按清单报告已完成项和遗留项。",
                "交付检查清单",
            )
        } else {
            (
                "Before handoff, read the [checklist](references/checklist.md) and report completed checks and open items.",
                "Delivery checklist",
            )
        };
        let artifact_direction = if pack.chinese {
            format!("使用[工作模板]({})记录交付结果。", pack.artifact_path)
        } else {
            format!(
                "Use the [working template]({}) to record the deliverable.",
                pack.artifact_path
            )
        };
        let mut checklist = format!("# {title}\n\n## {section}\n\n");
        for item in pack.text["checklist"].as_array().ok_or_else(unavailable)? {
            let item = item
                .as_str()
                .filter(|item| !item.trim().is_empty())
                .ok_or_else(unavailable)?;
            checklist.push_str(&format!("- [ ] {item}\n"));
        }
        let manifest = json!({
            "root": pack.id,
            "frontmatter": {
                "license": "MIT",
                "metadata": {"title":title,"source":"bambooshift-starter"}
            },
            "files": [
                {"path":"references/checklist.md","base64":STANDARD.encode(checklist)},
                {"path":pack.artifact_path,"base64":STANDARD.encode(pack.artifact_content)}
            ]
        });
        let body = json!({
            "agentId":agent_id,"name":pack.id,"description":pack.text["description"],
            "content":format!("{instructions}\n\n{direction} {artifact_direction}\n"),"skillPackage":manifest
        });
        let mut skill = knowledge::stage_skill(conn, &body, None).await?;
        knowledge::activate_skill(conn, &mut skill, &[], true).await?;
        installed.push(skill);
    }
    Ok(installed)
}
