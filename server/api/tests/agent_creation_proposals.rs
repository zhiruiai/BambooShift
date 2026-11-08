mod agent_delegation_support;
mod shared_bots_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, has_tool_result, role, wait_gate};
use openbot_backend::{db::State, workspace::Table};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;

fn bot() -> Value {
    json!({"name":"Research partner","role":"Researcher","description":"Compare sources.",
        "instructions":"Verify claims and summarize evidence.","avatar":"spark","color":"#AABBCC"})
}

fn theme() -> Value {
    json!({"name":"星空伙伴","motif":"elephants","colors":["#AABBCC","#18293A","#DDEEFF"],
        "badge":"moon","backdrop":"halo"})
}

fn drafts(messages: &[Value]) -> Vec<&Value> {
    messages
        .iter()
        .filter(|m| m["kind"] == "creation_preview")
        .collect()
}

fn tools(body: &Value, name: &str) -> Option<Value> {
    body["tools"]
        .as_array()?
        .iter()
        .find(|tool| tool["function"]["name"] == name)
        .cloned()
}

fn assert_tools_absent(body: &Value) {
    assert!(tools(body, "propose_bot").is_none());
    assert!(tools(body, "propose_avatar_theme").is_none());
}

async fn direct() -> Group {
    let mut group = Group::new().await;
    let chat = group
        .store
        .list(Table::Conversations)
        .await
        .unwrap()
        .into_iter()
        .find(|chat| chat["isGroup"] == false && chat["agentIds"] == json!([group.ids[0]]))
        .unwrap();
    group.cid = chat["id"].as_str().unwrap().to_owned();
    group
}

#[tokio::test]
async fn owner_pi_drafts_are_exact_persistent_and_deduplicated() {
    let group = direct().await;
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            let bot_schema = tools(&body, "propose_bot").unwrap();
            assert_eq!(
                bot_schema["function"]["parameters"]["additionalProperties"],
                false
            );
            let theme_schema = tools(&body, "propose_avatar_theme").unwrap();
            assert_eq!(
                theme_schema["function"]["parameters"]["properties"]["motif"]["enum"],
                json!(["companions", "pandas", "dinosaurs", "chicks", "elephants"])
            );
            let result_count = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "tool")
                .count();
            match result_count {
                0 => call("propose_bot", bot()),
                1 => call("propose_avatar_theme", theme()),
                2 => {
                    let mut retry = bot();
                    retry["color"] = json!("#aabbcc");
                    call("propose_bot", retry)
                }
                3 => {
                    let mut malformed = theme();
                    malformed["css"] = json!("background:red");
                    call("propose_avatar_theme", malformed)
                }
                _ => {
                    assert!(body.to_string().contains("requiresOwnerConfirmation"));
                    finish("Two drafts are ready to review.")
                }
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let agents = group.store.list(Table::Agents).await.unwrap().len();
    let conversations = group.store.list(Table::Conversations).await.unwrap().len();
    let input = group
        .send(
            "Draft a research Bot and an avatar theme.",
            "followUp",
            false,
        )
        .await;
    let messages = group.done().await;
    let cards = drafts(&messages);
    assert_eq!(cards.len(), 2);
    let mut expected_profile = bot();
    expected_profile["avatarImageId"] = Value::Null;
    expected_profile["color"] = json!("#aabbcc");
    let mut expected_theme = theme();
    expected_theme["colors"] = json!(["#aabbcc", "#18293a", "#ddeeff"]);
    let run_id = &messages.iter().find(|m| m["id"] == input["id"]).unwrap()["delivery"]["runId"];
    let expected = [
        (
            "bot",
            "Research partner",
            json!({"kind":"bot","profile":expected_profile}),
        ),
        (
            "theme",
            "星空伙伴",
            json!({"kind":"theme","theme":expected_theme}),
        ),
    ];
    for (kind, label, draft) in expected {
        let card = cards
            .iter()
            .find(|m| m["metadata"]["creationPreview"]["kind"] == kind)
            .unwrap();
        assert_eq!(card["role"], "assistant");
        assert_eq!(card["content"], label);
        assert_eq!(card["status"], "done");
        assert_eq!(card["metadata"]["creationPreview"], draft);
        assert_eq!(card["metadata"]["requesterUserId"], group.f.owner);
        assert_eq!(card["metadata"]["inputMessageId"], input["id"]);
        assert_eq!(&card["metadata"]["runId"], run_id);
    }
    assert_eq!(group.store.list(Table::Agents).await.unwrap().len(), agents);
    assert_eq!(
        group.store.list(Table::Conversations).await.unwrap().len(),
        conversations
    );
    let receipts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM creation_requests")
        .fetch_one(&group.store.pool)
        .await
        .unwrap();
    assert_eq!(receipts, 0);

    let cfg = group.f.state.config.clone();
    let wid = group.f.workspace.clone();
    group.f.state.close().await;
    let restored = State::open((*cfg).clone()).await.unwrap();
    let store = restored.workspace.get(&wid, &wid).await.unwrap();
    for card in cards {
        let saved = store
            .get(Table::Messages, card["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&saved, card);
    }
    restored.close().await;
    group.close().await;
}

#[tokio::test]
async fn member_and_routine_cannot_post_a_direct_chat_draft() {
    let group = direct().await;
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            assert_tools_absent(&body);
            if has_tool_result(&body) {
                finish("Draft tool unavailable.")
            } else {
                call("propose_bot", bot())
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Try a draft as a member.", "followUp", true)
        .await;
    assert!(drafts(&group.done().await).is_empty());
    let (status,routine)=group.f.request("POST",&group.f.path("/routines"),Some(json!({"title":"Synthetic routine","prompt":"Draft a Bot","agentId":group.ids[0],"conversationId":group.cid,"schedule":"daily:09:00","enabled":false})),false,Some(&group.f.owner)).await;
    assert_eq!(status, 201, "{routine}");
    let (status, result) = group
        .f
        .request(
            "POST",
            &group.f.path(&format!(
                "/routines/{}/run",
                routine["id"].as_str().unwrap()
            )),
            None,
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 202, "{result}");
    assert!(drafts(&group.done().await).is_empty());
    assert!(model.calls.lock().await.len() >= 2);
    group.close().await;
}

#[tokio::test]
async fn group_and_delegated_models_cannot_post_drafts() {
    let group = Group::new().await;
    let child = group.ids[1].clone();
    let model = Model::new(Arc::new(move |body| {
        let child = child.clone();
        Box::pin(async move {
            assert_tools_absent(&body);
            if has_tool_result(&body) {
                finish("Draft tool unavailable.")
            } else if role(&body) == 0 {
                call(
                    "delegate",
                    json!({"agentId":child,"task":"Try to propose a theme."}),
                )
            } else {
                assert_eq!(role(&body), 1);
                call("propose_avatar_theme", theme())
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Ask the colleague about a theme.", "followUp", false)
        .await;
    assert!(drafts(&group.done().await).is_empty());
    assert!(model.calls.lock().await.iter().any(|body| role(body) == 1));
    group.close().await;
}

#[tokio::test]
async fn draft_is_refused_after_the_requester_loses_ownership() {
    let group = direct().await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let model = Model::new(Arc::new({
        let (entered, release) = (entered.clone(), release.clone());
        move |body| {
            let (entered, release) = (entered.clone(), release.clone());
            Box::pin(async move {
                assert!(tools(&body, "propose_bot").is_some());
                if has_tool_result(&body) {
                    return finish("The proposal was refused.");
                }
                entered.add_permits(1);
                wait_gate(&release).await;
                call("propose_bot", bot())
            })
        }
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Wait, then propose a draft.", "followUp", false)
        .await;
    wait_gate(&entered).await;
    sqlx::query("UPDATE memberships SET role='member' WHERE user_id=? AND workspace_id=?")
        .bind(&group.f.owner)
        .bind(&group.f.workspace)
        .execute(&group.f.db)
        .await
        .unwrap();
    release.add_permits(1);
    assert!(drafts(&group.done().await).is_empty());
    group.close().await;
}

#[tokio::test]
async fn shared_bot_cannot_post_drafts_in_the_receiving_owners_direct_chat() {
    let shared = shared_bots_support::Shared::new().await;
    let joined = shared.add().await;
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            assert_tools_absent(&body);
            if has_tool_result(&body) {
                finish("Draft tool unavailable.")
            } else {
                call("propose_avatar_theme", theme())
            }
        })
    }))
    .await;
    let prefix = format!("/api/workspaces/{}", shared.personal);
    assert_eq!(
        shared
            .f
            .request(
                "PUT",
                &format!("{prefix}/settings"),
                Some(model.config()),
                true,
                Some(&shared.f.member)
            )
            .await
            .0,
        200
    );
    let body = json!({"content":"Draft an avatar theme.","clientId":uuid::Uuid::new_v4().to_string(),"agentId":joined["agentId"]});
    let cid = joined["conversationId"].as_str().unwrap();
    assert_eq!(
        shared
            .f
            .request(
                "POST",
                &format!("{prefix}/conversations/{cid}/messages"),
                Some(body),
                true,
                Some(&shared.f.member)
            )
            .await
            .0,
        202
    );
    tokio::time::timeout(std::time::Duration::from_secs(35), async {
        while !shared
            .f
            .state
            .agent_runs
            .requests(&shared.personal)
            .await
            .is_empty()
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let store = shared
        .f
        .state
        .workspace
        .get(&shared.personal, &shared.personal)
        .await
        .unwrap();
    assert!(drafts(&store.list(Table::Messages).await.unwrap()).is_empty());
    assert!(!model.calls.lock().await.is_empty());
    shared.f.close().await;
}
