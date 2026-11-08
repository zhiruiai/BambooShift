mod agent_delegation_support;
mod knowledge_acceptance_support;
mod scheduling_support;
mod workspace_support;

use agent_delegation_support::{Model, call, finish};
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use knowledge_acceptance_support::{
    add_memory, configure, latest_tool, owner, recall, result, seed_long_skills, system, tools,
};
use openbot_backend::{product_router, workspace::Table};
use scheduling_support::{Fixture, at, routine, store, wait};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use tower::ServiceExt;

const EVENT: &str = "SYNTHETIC_WEBHOOK_EVENT_ONLY";
const MEMORY: &str = "SYNTHETIC_AUTOMATION_MEMORY_NEEDLE";
const COMPLETE: &str = "The synthetic automation read its permitted knowledge.";

async fn automation_model(skill: Value, checkin: bool) -> Model {
    let long_skill = Arc::new(skill);
    Model::new(Arc::new(move |body| {
        let skill = long_skill.clone();
        Box::pin(async move {
            let mut allowed = vec!["list_skills", "read_skill"];
            if checkin {
                allowed.push("recall");
            }
            assert_eq!(tools(&body), allowed);
            let prompt = system(&body);
            assert!(!prompt.contains("SYNTHETIC_METHOD_TAIL_07"));
            assert!(!prompt.contains(MEMORY));
            assert!(prompt.encode_utf16().count() < 128_000);
            let delivered_event = body["messages"].to_string().contains(EVENT);
            assert_eq!(delivered_event, !checkin);
            let results = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "tool")
                .count();
            match results {
                0 => call("list_skills", json!({"query":"method 07"})),
                1 => {
                    let catalog = result(latest_tool(&body).unwrap());
                    assert_eq!(catalog["total"], 8);
                    assert_eq!(catalog["matched"], 1);
                    assert_eq!(catalog["skills"][0]["id"], skill["id"]);
                    assert!(catalog["skills"][0].get("content").is_none());
                    call("read_skill", json!({"skillId":skill["id"]}))
                }
                2 => {
                    let read = result(latest_tool(&body).unwrap());
                    assert_eq!(read["version"], 1);
                    assert!(read["nextOffset"].is_null());
                    assert_eq!(
                        read["content"].as_str().map(|content| content.len()),
                        skill["content"].as_str().map(|content| content.len())
                    );
                    assert!(
                        read["content"]
                            .as_str()
                            .unwrap()
                            .ends_with("SYNTHETIC_METHOD_TAIL_07🚀")
                    );
                    if checkin {
                        recall(MEMORY, None)
                    } else {
                        finish(COMPLETE)
                    }
                }
                3 if checkin => {
                    let memories = result(latest_tool(&body).unwrap());
                    assert_eq!(memories["total"], 12);
                    assert_eq!(memories["matched"], 1);
                    assert!(
                        memories["memories"][0]["content"]
                            .as_str()
                            .unwrap()
                            .ends_with(MEMORY)
                    );
                    finish(COMPLETE)
                }
                _ => panic!("Unexpected automation knowledge step"),
            }
        })
    }))
    .await
}

#[tokio::test]
async fn oversized_daily_checkin_reads_its_snapshot_with_no_write_or_external_tools() {
    let fixture = Fixture::new().await;
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&fixture.workspace)
        .execute(&fixture.db)
        .await
        .unwrap();
    let bootstrap = fixture.bootstrap().await;
    let bot = bootstrap["agents"][0]["id"].as_str().unwrap();
    let skills = seed_long_skills(&fixture, bot).await;
    for index in 0..12 {
        let tail = if index == 11 { MEMORY } else { "" };
        add_memory(
            &fixture,
            bot,
            &format!("Synthetic memory {index} {}{tail}", "记".repeat(1000)),
        )
        .await;
    }
    let model = automation_model(skills.last().unwrap().clone(), true).await;
    configure(&fixture, &model).await;
    let (status, selected) = owner(
        &fixture,
        "PUT",
        "/primary-bot",
        json!({"mode":"select","expectedRevision":"unset","agentId":bot,
            "checkIn":{"enabled":true,"time":"09:00","timeZone":"Asia/Shanghai"}}),
    )
    .await;
    assert_eq!(status, 200, "{selected}");
    openbot_backend::scheduling::tick(&fixture.state, at("2027-01-01T01:01:00Z"))
        .await
        .unwrap();
    let workspace = store(&fixture).await;
    wait(&workspace, |messages| {
        messages
            .iter()
            .any(|row| row["content"] == COMPLETE && row["status"] == "done")
    })
    .await;
    assert_eq!(workspace.list(Table::Memories).await.unwrap().len(), 12);
    assert_eq!(workspace.list(Table::Skills).await.unwrap().len(), 8);
    assert_eq!(model.calls.lock().await.len(), 4);
    drop(model);
    fixture.close().await;
}

#[tokio::test]
async fn oversized_webhook_reads_skills_without_receiving_memory_or_other_tools() {
    let fixture = Fixture::new().await;
    let scheduled = routine(&fixture).await;
    let bot = scheduled["agentId"].as_str().unwrap();
    let skills = seed_long_skills(&fixture, bot).await;
    add_memory(&fixture, bot, MEMORY).await;
    let model = automation_model(skills.last().unwrap().clone(), false).await;
    configure(&fixture, &model).await;
    let (status, key) = owner(
        &fixture,
        "PUT",
        &format!("/routines/{}/webhook", scheduled["id"].as_str().unwrap()),
        json!({"expectedRevision":"unset"}),
    )
    .await;
    assert_eq!(status, 200);
    let mut request = Request::builder()
        .method("POST")
        .uri(key["path"].as_str().unwrap())
        .header("host", "127.0.0.1:3002")
        .header("content-type", "application/json")
        .header(
            "authorization",
            format!("Bearer {}", key["secret"].as_str().unwrap()),
        )
        .header("idempotency-key", "synthetic-long-knowledge-webhook")
        .body(Body::from(json!({"canary":EVENT}).to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:45555".parse::<SocketAddr>().unwrap(),
    ));
    let response = product_router(fixture.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let receipt: Value = serde_json::from_slice(&to_bytes(body, 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(parts.status.as_u16(), 202, "{receipt}");
    let workspace = store(&fixture).await;
    let messages = wait(&workspace, |messages| {
        messages
            .iter()
            .any(|row| row["content"] == COMPLETE && row["status"] == "done")
    })
    .await;
    assert!(!json!(messages).to_string().contains(EVENT));
    assert_eq!(workspace.list(Table::Memories).await.unwrap().len(), 1);
    assert_eq!(workspace.list(Table::Skills).await.unwrap().len(), 8);
    assert_eq!(model.calls.lock().await.len(), 3);
    drop(model);
    fixture.close().await;
}
