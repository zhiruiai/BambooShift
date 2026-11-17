use super::{Table, WorkspaceStore, knowledge};
use crate::error::{ApiError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::sync::LazyLock;

static EN: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../mobile/assets/skills/en.json")).unwrap()
});
static ZH: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../mobile/assets/skills/zh.json")).unwrap()
});
static RESOURCES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../shared/skill-workflow-resources.json"
    ))
    .unwrap()
});
pub(crate) const FOUNDATION: &[&str] = &[
    "web-research",
    "browser-use",
    "computer-use",
    "agent-desktop",
];

pub(crate) fn catalog(language: &str) -> &'static [Value] {
    let catalog = if language == "zh-CN" { &*ZH } else { &*EN };
    catalog.as_array().expect("checked-in skill catalog")
}

pub(crate) fn recipe(id: &str, language: &str) -> Option<&'static Value> {
    catalog(language).iter().find(|item| item["id"] == id)
}

/// The same package bytes and frontmatter used by the Web and mobile catalog.
pub(crate) fn package(id: &str, language: &str, agent_id: &Value) -> Result<Value> {
    if !matches!(language, "en" | "zh-CN") {
        return Err(ApiError::bad("技能语言无效。"));
    }
    let recipe = recipe(id, language).ok_or_else(|| ApiError::bad("内置技能包不存在。"))?;
    let resources = &RESOURCES[id];
    let mut frontmatter = json!({"metadata":{"title":recipe["name"],"source":resources["source"]}});
    for key in ["license", "compatibility"] {
        if let Some(value) = resources.get(key) {
            frontmatter[key] = value.clone();
        }
    }
    let files: Vec<Value> = resources["files"].as_object().unwrap().iter()
        .map(|(path, content)| json!({"path":path,"base64":STANDARD.encode(content.as_str().unwrap())}))
        .collect();
    Ok(json!({
        "agentId":agent_id,"name":id,"description":recipe["description"],
        "content":format!("{}\n\n{}\n",recipe["content"].as_str().unwrap().trim_end(),resources["instruction"][language].as_str().unwrap()),
        "skillPackage":{"root":id,"frontmatter":frontmatter,"files":files}
    }))
}

pub(crate) async fn install(conn: &mut SqliteConnection, body: &Value) -> Result<Value> {
    let mut skill = knowledge::stage_skill(conn, body, None).await?;
    knowledge::activate_skill(conn, &mut skill, &[], true).await?;
    Ok(skill)
}

/// Initialize guidance once. Never restore a user's subsequently removed or disabled skill.
pub(crate) async fn ensure_foundation(conn: &mut SqliteConnection, agent: &Value) -> Result<()> {
    if agent.get("sharedBot").is_some() {
        return Ok(());
    }
    let id = agent["id"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Bot 无效。"))?;
    let marker = format!("foundation-skills:{id}");
    if WorkspaceStore::get_in(conn, Table::Settings, &marker)
        .await?
        .is_some()
    {
        return Ok(());
    }
    let language = if agent["name"]
        .as_str()
        .unwrap_or("")
        .chars()
        .any(|c| matches!(c as u32, 0x3400..=0x9fff))
    {
        "zh-CN"
    } else {
        "en"
    };
    let all = WorkspaceStore::list_in(conn, Table::Skills).await?;
    for name in FOUNDATION {
        // Existing authored or disabled lineages are the owner's choice, not ours to replace.
        if all
            .iter()
            .any(|s| s["agentId"] == agent["id"] && s["name"] == *name)
        {
            continue;
        }
        install(conn, &package(name, language, &agent["id"])?).await?;
    }
    WorkspaceStore::put_in(conn, Table::Settings, &json!({"id":marker,"version":1})).await?;
    Ok(())
}
