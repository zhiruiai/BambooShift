mod agent_delegation_support;
mod knowledge_acceptance_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, wait_gate};
use axum::{body::Body, http::Response};
use knowledge_acceptance_support::{approve, latest_tool, owner, propose, result, system, tools};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

const REVIEWED: &str = "SYNTHETIC_REVIEWED_RECIPE";
const LONG_END: &str = "SYNTHETIC_SELECTED_LONG_TAIL";
const FINISHED: &str = "The reviewed skill supplied the workflow for this task.";

fn message(bot: &str, skill: &Value) -> Value {
    json!({"content":"Exercise the selected workflow with synthetic data.","clientId":uuid::Uuid::new_v4().to_string(),"agentId":bot,"mode":"steer","skillId":skill["id"]})
}

async fn send(group: &Group, message: Value) -> (u16, Value) {
    owner(
        &group.f,
        "POST",
        &format!("/conversations/{}/messages", group.cid),
        message,
    )
    .await
}

async fn turn(group: &Group, input: &Value) -> Value {
    tokio::time::timeout(Duration::from_secs(35), async {
        loop {
            let messages = group.store.list(Table::Messages).await.unwrap();
            if let Some(message) = messages.into_iter().find(|message| {
                message["metadata"]["inputMessageId"] == input["id"]
                    && matches!(message["status"].as_str(), Some("done" | "error"))
            }) {
                return message;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Selected-skill task did not finish")
}

#[tokio::test]
async fn actual_pi_receives_the_reviewed_packaged_skill_and_can_read_a_long_selected_version() {
    let group = Group::new().await;
    let bot = &group.ids[0];
    let recipes: Value =
        serde_json::from_str(include_str!("../../../mobile/assets/skills/en.json")).unwrap();
    let recipe = recipes
        .as_array()
        .unwrap()
        .iter()
        .find(|recipe| recipe["id"] == "agent-desktop")
        .expect("The bundled desktop workflow must be available for explicit selection");
    let name = recipe["name"].as_str().unwrap();
    let content = format!("{}\n\n{REVIEWED}", recipe["content"].as_str().unwrap());
    let draft = propose(&group.f, bot, name, &content).await;
    let (code, blocked) = send(&group, message(bot, &draft)).await;
    assert_eq!(code, 409);
    assert_eq!(blocked["code"], "SKILL_CONTEXT_UNAVAILABLE");

    let chosen = approve(&group.f, &draft, None).await;
    let long = propose(
        &group.f,
        bot,
        "Synthetic long reviewed method",
        &format!("{}{LONG_END}", "长".repeat(11_000)),
    )
    .await;
    let long = approve(&group.f, &long, None).await;
    let foreign = propose(&group.f, &group.ids[1], name, "FOREIGN_SKILL_CANARY").await;
    let foreign = approve(&group.f, &foreign, None).await;
    assert_eq!(send(&group, message(bot, &foreign)).await.0, 409);

    let chosen_id = chosen["id"].as_str().unwrap().to_owned();
    let long_id = long["id"].as_str().unwrap().to_owned();
    let model = Model::new(Arc::new(move |body| {
        let (chosen_id, long_id, content) = (chosen_id.clone(), long_id.clone(), content.clone());
        Box::pin(async move {
            let system = system(&body);
            assert!(!system.contains("FOREIGN_SKILL_CANARY"));
            assert!(system.len() < 128_000);
            let selected = system
                .lines()
                .find(|line| line.starts_with("The human selected this approved skill"))
                .expect("Pi did not receive the selected workflow");
            assert!(selected.contains("grants no tool access or approval"));
            if selected.contains(&long_id) {
                assert!(selected.contains("read_skill"));
                assert!(!selected.contains(LONG_END));
                assert!(tools(&body).contains(&"read_skill"));
                if let Some(receipt) = latest_tool(&body) {
                    let read = result(receipt);
                    assert_eq!(read["id"], long_id);
                    assert_eq!(read["version"], 1);
                    assert!(read["content"].as_str().unwrap().ends_with(LONG_END));
                    finish(LONG_END)
                } else {
                    call("read_skill", json!({"skillId":long_id}))
                }
            } else {
                assert!(selected.contains(&chosen_id));
                assert!(selected.contains(&json!(content).to_string()));
                finish(FINISHED)
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let request = message(bot, &chosen);
    let (status, accepted) = send(&group, request.clone()).await;
    assert_eq!(status, 202, "{accepted}");
    assert_eq!(accepted["message"]["skillId"], chosen["id"]);
    assert!(group.done().await.iter().any(|m| m["content"] == FINISHED));
    assert_eq!(model.calls.lock().await.len(), 1);
    let mut wrong_retry = request.clone();
    wrong_retry["skillId"] = long["id"].clone();
    assert_eq!(send(&group, wrong_retry).await.0, 409);
    let (status, retry) = send(&group, request).await;
    assert_eq!(status, 202);
    assert_eq!(retry["message"]["id"], accepted["message"]["id"]);
    assert_eq!(model.calls.lock().await.len(), 1);

    assert_eq!(send(&group, message(bot, &long)).await.0, 202);
    assert!(group.done().await.iter().any(|m| m["content"] == LONG_END));
    assert_eq!(model.calls.lock().await.len(), 3);
    let revised = propose(&group.f, bot, name, "SYNTHETIC_REPLACEMENT_RECIPE").await;
    let revised = approve(&group.f, &revised, Some(&chosen)).await;
    assert_eq!(revised["version"], 2);
    assert_eq!(send(&group, message(bot, &chosen)).await.0, 409);
    assert_eq!(model.calls.lock().await.len(), 3);
    group.close().await;
}

#[tokio::test]
async fn a_skill_disabled_while_queued_cannot_steer_or_execute_a_later_pi_run() {
    let group = Group::new().await;
    let bot = &group.ids[0];
    let draft = propose(
        &group.f,
        bot,
        "Synthetic queued skill",
        "QUEUED_REVIEWED_BODY",
    )
    .await;
    let skill = approve(&group.f, &draft, None).await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (ready, gate) = (entered.clone(), release.clone());
    let model = Model::new(Arc::new(move |body| {
        let (ready, gate) = (ready.clone(), gate.clone());
        Box::pin(async move {
            assert!(!system(&body).contains("The human selected this approved skill"));
            ready.add_permits(1);
            wait_gate(&gate).await;
            finish("Original synthetic task finished.")
        })
    }))
    .await;
    group.configure(&model).await;
    group.send("Hold the first run", "followUp", false).await;
    wait_gate(&entered).await;
    let (status, queued) = send(&group, message(bot, &skill)).await;
    assert_eq!(status, 202, "{queued}");
    let (status, _) = owner(
        &group.f,
        "POST",
        &format!("/skills/{}/disable", skill["id"].as_str().unwrap()),
        json!({"expectedActiveId":skill["id"]}),
    )
    .await;
    assert_eq!(status, 200);
    release.add_permits(1);
    let cancelled = turn(&group, &queued["message"]).await;
    assert_eq!(model.calls.lock().await.len(), 1);
    assert_eq!(cancelled["metadata"]["executionStatus"], "cancelled");
    assert_eq!(send(&group, message(bot, &skill)).await.0, 409);
    group.close().await;
}

#[tokio::test]
async fn independent_skill_tasks_survive_a_preceding_error_and_fence_later_inputs() {
    const BEFORE: &str = "SYNTHETIC_HELD_FAILURE";
    const FIRST: &str = "SYNTHETIC_FIRST_SELECTED_TASK";
    const SECOND: &str = "SYNTHETIC_SECOND_SELECTED_TASK";
    let group = Group::new().await;
    let bot = &group.ids[1];
    let first = propose(
        &group.f,
        bot,
        "First selected skill",
        "SYNTHETIC_FIRST_RECIPE",
    )
    .await;
    let first = approve(&group.f, &first, None).await;
    let second = propose(
        &group.f,
        bot,
        "Second selected skill",
        "SYNTHETIC_SECOND_RECIPE",
    )
    .await;
    let second = approve(&group.f, &second, None).await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (ready, gate) = (entered.clone(), release.clone());
    let model = Model::new(Arc::new(move |body| {
        let (ready, gate) = (ready.clone(), gate.clone());
        Box::pin(async move {
            let content = &body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|message| message["role"] == "user")
                .unwrap()["content"];
            let text = content
                .as_str()
                .or_else(|| {
                    content
                        .as_array()?
                        .iter()
                        .find_map(|block| block["text"].as_str())
                })
                .expect("Pi supplied a text prompt");
            let prompt: Value = serde_json::from_str(text).unwrap();
            let current = prompt["content"].as_str().unwrap();
            let selected = system(&body)
                .lines()
                .find(|line| line.starts_with("The human selected this approved skill"))
                .unwrap_or_default()
                .to_owned();
            if selected.contains("SYNTHETIC_FIRST_RECIPE") {
                assert_eq!(current, FIRST);
                assert!(!prompt["history"].to_string().contains(SECOND));
                ready.add_permits(1);
                wait_gate(&gate).await;
                return finish("First selection ran independently.");
            }
            if selected.contains("SYNTHETIC_SECOND_RECIPE") {
                assert_eq!(current, SECOND);
                return finish("Second selection ran independently.");
            }
            if current == "SYNTHETIC_UNADDRESSED_TASK" {
                return finish("Unaddressed task returned to the group lead.");
            }
            assert_eq!(current, BEFORE);
            ready.add_permits(1);
            wait_gate(&gate).await;
            Response::builder()
                .status(400)
                .body(Body::from(
                    r#"{"error":{"message":"SYNTHETIC_MODEL_ERROR"}}"#,
                ))
                .unwrap()
        })
    }))
    .await;
    group.configure(&model).await;
    let failing = group.send(BEFORE, "followUp", false).await;
    wait_gate(&entered).await;
    let queued = |skill: &Value, content: &str| {
        let mut input = message(bot, skill);
        input["content"] = json!(content);
        input
    };
    let (status, first) = send(&group, queued(&first, FIRST)).await;
    assert_eq!(status, 202, "{first}");
    assert_eq!(first["message"]["delivery"]["mode"], "followUp");
    let (status, second) = send(&group, queued(&second, SECOND)).await;
    assert_eq!(status, 202, "{second}");
    release.add_permits(1);
    assert_eq!(turn(&group, &failing).await["status"], "error");
    wait_gate(&entered).await;

    let (status, ordinary) = send(
        &group,
        json!({
            "content":"SYNTHETIC_UNADDRESSED_TASK",
            "clientId":uuid::Uuid::new_v4().to_string(),
            "mode":"followUp"
        }),
    )
    .await;
    assert_eq!(status, 202, "{ordinary}");
    assert_eq!(ordinary["message"]["delivery"]["agentId"], group.ids[0]);
    release.add_permits(1);
    assert_eq!(
        turn(&group, &first["message"]).await["content"],
        "First selection ran independently."
    );
    assert_eq!(
        turn(&group, &second["message"]).await["content"],
        "Second selection ran independently."
    );
    assert_eq!(
        turn(&group, &ordinary["message"]).await["content"],
        "Unaddressed task returned to the group lead."
    );
    assert_eq!(model.calls.lock().await.len(), 4);
    group.done().await;
    group.close().await;
}
