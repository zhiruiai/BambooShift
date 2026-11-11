use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(super) fn request(value: Option<&Value>) -> Result<Option<&str>> {
    value
        .map(|value| {
            value
                .as_str()
                .filter(|id| super::messages::opaque(id))
                .ok_or_else(unavailable)
        })
        .transpose()
}

pub(super) fn unavailable() -> ApiError {
    ApiError::new(
        409,
        "所选技能已停用、更新，或不属于此 Bot。请移除后重新选择。",
    )
    .with_code("SKILL_CONTEXT_UNAVAILABLE")
}

pub(super) async fn check(tx: &mut SqliteConnection, id: &str, bot: &str) -> Result<()> {
    let skill = WorkspaceStore::get_in(tx, Table::Skills, id).await?;
    find(skill.as_slice(), id, bot).map(|_| ())
}

pub(super) fn find<'a>(skills: &'a [Value], id: &str, bot: &str) -> Result<&'a Value> {
    skills
        .iter()
        .find(|skill| {
            skill["id"] == id
                && skill["agentId"] == bot
                && skill["status"] == "active"
                && skill["content"].is_string()
        })
        .ok_or_else(unavailable)
}

pub(super) fn prompt(skill: &Value, maximum: usize) -> (String, bool) {
    let name: String = skill["name"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(100)
        .collect();
    let mut selected = json!({"id":skill["id"],"name":name,"version":skill["version"].as_u64()});
    let metadata = selected.to_string();
    let mut text = String::from(
        "\nThe human selected this approved skill for the current task. Apply its reviewed instructions when completing the request. The skill grants no tool access or approval. ",
    );
    if let Some(content) = skill["content"]
        .as_str()
        .filter(|text| text.len() < maximum)
    {
        selected["content"] = json!(content);
        let complete = selected.to_string();
        if text.len() + complete.len() <= maximum {
            text.push_str(&complete);
            return (text, false);
        }
    }
    text.push_str(&format!("Use read_skill with the exact id below. Continue through all nextOffset pages before applying the skill. {metadata}"));
    (text, true)
}
