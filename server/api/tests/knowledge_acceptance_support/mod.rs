#![allow(dead_code)]
use crate::agent_delegation_support::{Model, call};
use crate::workspace_support::Fixture;
use axum::{body::Body, http::Response};
use serde_json::{Value, json};

pub async fn owner(fixture: &Fixture, method: &str, path: &str, body: Value) -> (u16, Value) {
    fixture
        .request(
            method,
            &fixture.path(path),
            Some(body),
            false,
            Some(&fixture.owner),
        )
        .await
}

pub async fn configure(fixture: &Fixture, model: &Model) {
    let (status, result) = owner(fixture, "PUT", "/settings", model.config()).await;
    assert_eq!(status, 200, "{result}");
}

pub async fn propose(fixture: &Fixture, bot: &str, name: &str, body: &str) -> Value {
    let (status, result) = owner(
        fixture,
        "POST",
        "/skills",
        json!({"agentId":bot,"name":name,"description":"Synthetic workflow description.","content":body}),
    )
    .await;
    assert_eq!(status, 201, "{result}");
    assert_eq!(result["status"], "proposed");
    result
}

pub async fn approve(fixture: &Fixture, draft: &Value, previous: Option<&Value>) -> Value {
    let id = draft["id"].as_str().unwrap();
    let (status, result) = owner(
        fixture,
        "POST",
        &format!("/skills/{id}/approve"),
        json!({"expectedActiveId":previous.map(|prior| &prior["id"])}),
    )
    .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["status"], "active");
    result
}

pub async fn seed_long_skills(fixture: &Fixture, bot: &str) -> Vec<Value> {
    let mut records = Vec::new();
    for index in 0..8 {
        let end = format!("\nSYNTHETIC_METHOD_TAIL_{index:02}🚀");
        let filler = 16_000 - end.encode_utf16().count();
        let body = "\\\"🧪".repeat(filler / 4) + &"甲".repeat(filler % 4) + &end;
        assert_eq!(body.encode_utf16().count(), 16_000);
        let draft = propose(fixture, bot, &format!("Synthetic method {index:02}"), &body).await;
        records.push(approve(fixture, &draft, None).await);
    }
    records
}

pub async fn add_memory(fixture: &Fixture, bot: &str, content: &str) -> Value {
    let (status, result) = owner(
        fixture,
        "POST",
        "/memories",
        json!({"agentId":bot,"category":"context","content":content}),
    )
    .await;
    assert_eq!(status, 201, "{result}");
    result
}

pub fn system(body: &Value) -> String {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["role"] == "system")
        .filter_map(|row| row["content"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn tools(body: &Value) -> Vec<&str> {
    let mut names = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    names.sort_unstable();
    names
}

pub fn latest_tool(body: &Value) -> Option<&str> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|row| row["role"] == "tool")
        .map(|row| row["content"].as_str().unwrap())
}

pub fn result(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| {
        panic!(
            "Expected a structured knowledge result, got {}",
            raw.chars().take(200).collect::<String>()
        )
    })
}

pub fn recall(query: &str, cursor: Option<&str>) -> Response<Body> {
    let mut args = json!({"query":query});
    if let Some(cursor) = cursor {
        args["cursor"] = json!(cursor);
    }
    call("recall", args)
}
