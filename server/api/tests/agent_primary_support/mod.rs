#![allow(dead_code)]
pub use crate::agent_delegation_support::*;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};

pub async fn personal(mut group: Group) -> Group {
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&group.f.workspace)
        .execute(&group.f.db)
        .await
        .unwrap();
    let (status, selected) = group
        .f
        .request(
            "PUT",
            &group.f.path("/primary-bot"),
            Some(
                json!({"mode":"select","expectedRevision":"unset","agentId":group.ids[0],
            "checkIn":{"enabled":false,"time":"09:00"}}),
            ),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{selected}");
    group.cid = selected["conversationId"].as_str().unwrap().to_owned();
    group
}
pub async fn dm(group: &Group, index: usize) -> Value {
    let mut chats = group
        .store
        .list(Table::Conversations)
        .await
        .unwrap()
        .into_iter()
        .filter(|c| c["isGroup"] == false && c["agentIds"] == json!([group.ids[index]]))
        .collect::<Vec<_>>();
    chats.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    chats.remove(0)
}
pub fn system(body: &Value) -> String {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "system")
        .map(|m| m["content"].as_str().unwrap_or(""))
        .collect()
}
pub fn identity(body: &Value) -> Value {
    let system = system(body);
    let line = system
        .lines()
        .find_map(|line| {
            line.strip_prefix("Current Bot identity and owner-managed configuration: ")
        })
        .expect("Missing explicit self identity in actual Pi request");
    serde_json::from_str(line).unwrap()
}
pub async fn update(group: &Group, index: usize, changes: Value) {
    let bot = group
        .store
        .get(Table::Agents, &group.ids[index])
        .await
        .unwrap()
        .unwrap();
    let mut body = changes;
    body["expectedRevision"] = bot["configRevision"].clone();
    let (status, result) = group
        .f
        .request(
            "PATCH",
            &group.f.path(&format!("/agents/{}", group.ids[index])),
            Some(body),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{result}");
}
