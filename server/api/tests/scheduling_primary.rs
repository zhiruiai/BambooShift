mod agent_delegation_support;
mod agent_queue_support;
mod scheduling_support;
mod workspace_support;
use agent_delegation_support::{Model, finish};
use scheduling_support::{Fixture, at, store};
use serde_json::{Value, json};
use std::sync::Arc;

async fn select(f: &Fixture) -> Value {
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    let boot = f.bootstrap().await;
    let selected=f.request("PUT",&f.path("/primary-bot"),Some(json!({"mode":"select","expectedRevision":"unset","agentId":boot["agents"][0]["id"],"checkIn":{"enabled":true,"time":"09:00","timeZone":"Asia/Shanghai"}})),false,Some(&f.owner)).await;
    assert_eq!(selected.0, 200, "{}", selected.1);
    selected.1
}
#[tokio::test]
async fn primary_checkin_is_real_read_only_and_once_per_local_day_and_revision() {
    let f = Fixture::new().await;
    let model = Model::new(Arc::new(|_| {
        Box::pin(async { finish("Synthetic completed check-in.") })
    }))
    .await;
    assert_eq!(
        f.request(
            "PUT",
            &f.path("/settings"),
            Some(model.config()),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    let selected = select(&f).await;
    let skills_before = f.bootstrap().await["skills"].clone();
    let clock = at("2027-01-01T01:01:00Z");
    openbot_backend::scheduling::tick(&f.state, clock)
        .await
        .unwrap();
    let store = store(&f).await;
    scheduling_support::wait(&store, |messages| {
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["status"] == "done")
    })
    .await;
    openbot_backend::scheduling::tick(&f.state, clock + 120000)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM primary_check_ins WHERE revision=?")
        .bind(selected["revision"].as_str())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let sent = model.calls.lock().await;
    assert_eq!(sent.len(), 1);
    let mut tools: Vec<_> = sent[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect();
    tools.sort_unstable();
    assert_eq!(tools, ["list_skills", "read_skill", "read_skill_resource"]);
    drop(sent);
    let snapshot = f.bootstrap().await;
    assert_eq!(snapshot["primaryCheckIn"]["status"], "completed");
    assert!(snapshot["primaryCheckIn"]["lastMessageId"].is_string());
    assert!(snapshot["memories"].as_array().unwrap().is_empty());
    assert_eq!(snapshot["skills"], skills_before);
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn a_human_message_interrupts_a_checkin_without_discarding_the_human_queue() {
    let f = Fixture::new().await;
    let model = agent_queue_support::Model::new(&f).await;
    let selected = select(&f).await;
    openbot_backend::scheduling::tick(&f.state, at("2027-01-01T01:01:00Z"))
        .await
        .unwrap();
    model.wait().await;
    let input = agent_queue_support::submit(
        &f,
        selected["conversationId"].as_str().unwrap(),
        "Synthetic human request takes priority",
        "followUp",
        false,
    )
    .await;
    let snapshot = agent_queue_support::wait(&f, |s| {
        s["runningRequests"] == json!([])
            && s["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["role"] == "assistant" && m["status"] == "done")
    })
    .await;
    assert_eq!(
        snapshot["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == input["id"])
            .unwrap()["delivery"]["state"],
        "delivered"
    );
    assert_eq!(snapshot["primaryCheckIn"]["status"], "interrupted");
    assert_eq!(model.calls.lock().await.len(), 2);
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn changing_primary_config_stops_only_its_checkin_and_keeps_ordinary_tasks_authorized() {
    let f = Fixture::new().await;
    let model = agent_queue_support::Model::new(&f).await;
    let selected = select(&f).await;
    let cid = selected["conversationId"].as_str().unwrap();
    agent_queue_support::submit(
        &f,
        cid,
        "Ordinary task keeps its own authority",
        "followUp",
        false,
    )
    .await;
    model.wait().await;
    let cleared = f
        .request(
            "PUT",
            &f.path("/primary-bot"),
            Some(json!({"mode":"clear","expectedRevision":selected["revision"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(cleared.0, 200);
    assert_eq!(
        f.bootstrap().await["runningRequests"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    model.release.add_permits(1);
    let snapshot = agent_queue_support::wait(&f, |s| {
        s["runningRequests"] == json!([])
            && s["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["role"] == "assistant" && m["status"] == "done")
    })
    .await;
    assert_eq!(snapshot["primaryCheckIn"]["status"], "disabled");
    drop(model);
    f.close().await;
}
