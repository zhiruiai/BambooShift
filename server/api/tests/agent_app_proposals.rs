mod agent_delegation_support;
mod shared_bots_support;
mod workspace_support;
use agent_delegation_support::{Group, Model, call, finish, has_tool_result, role, wait_gate};
use openbot_backend::{db::State, workspace::Table};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;
fn proposals(messages: &[Value]) -> Vec<&Value> {
    messages
        .iter()
        .filter(|m| m["kind"] == "app_connection_proposal")
        .collect()
}
fn suggestion() -> axum::http::Response<axum::body::Body> {
    call(
        "suggest_app_connection",
        json!({"providerId":"notion","reason":"Organize the approved project notes."}),
    )
}

fn advertised(body: &Value, name: &str) -> bool {
    body["tools"]
        .as_array()
        .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == name))
}

fn lookup(query: &str) -> axum::http::Response<axum::body::Body> {
    call("list_app_providers", json!({"query":query}))
}

fn tool_result(body: &Value) -> Value {
    let output = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    serde_json::from_str(output["content"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn owner_pi_suggestion_is_persistent_deduplicated_and_never_connects() {
    let group = Group::new().await;
    let step = Arc::new(AtomicUsize::new(0));
    let model=Model::new(Arc::new(move |body| {let step=step.clone();Box::pin(async move {
        let tools=body["tools"].as_array().unwrap();
        let schema=tools.iter().find(|tool| tool["function"]["name"]=="suggest_app_connection").unwrap();
        let catalog: Vec<Value> = serde_json::from_str(include_str!("../../../shared/app-providers.json")).unwrap();
        let ids = catalog.iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>();
        assert_eq!(schema["function"]["parameters"]["properties"]["providerId"]["enum"], json!(ids));
        assert!(advertised(&body, "list_app_providers"));
        match step.fetch_add(1,Ordering::SeqCst) {
            0 => lookup("notion"),
            1 => {
                assert_eq!(tool_result(&body), json!({"providers":[{"providerId":"notion","name":"Notion","category":"productivity","authType":"oauth","connectionStatus":"not_connected"}],"hasMore":false}));
                suggestion()
            }
            2 => call("suggest_app_connection",json!({"providerId":"notion","reason":"Do not overwrite the first suggestion."})),
            _ => finish("Review the suggested connection when ready."),
        }
    })})).await;
    group.configure(&model).await;
    let input = group
        .send("Suggest an app, without connecting it.", "followUp", false)
        .await;
    let messages = group.done().await;
    let cards = proposals(&messages);
    assert_eq!(cards.len(), 1);
    let card = cards[0];
    assert_eq!(card["role"], "assistant");
    assert_eq!(card["status"], "done");
    let value = &card["metadata"]["appConnectionProposal"];
    assert_eq!(value["requester"]["userId"], group.f.owner);
    assert_eq!(value["requester"]["messageId"], input["id"]);
    assert_eq!(value["reason"], "Organize the approved project notes.");
    assert_eq!(
        value["runId"],
        messages.iter().find(|m| m["id"] == input["id"]).unwrap()["delivery"]["runId"]
    );
    assert!(!card.to_string().contains("https://"));
    let apps: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_connections")
        .fetch_one(&group.store.pool)
        .await
        .unwrap();
    assert_eq!(apps, 0);
    let oauth: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_oauth_flows")
        .fetch_one(&group.store.pool)
        .await
        .unwrap();
    assert_eq!(oauth, 0);
    let cfg = group.f.state.config.clone();
    let wid = group.f.workspace.clone();
    let id = card["id"].as_str().unwrap().to_owned();
    let expected = card.clone();
    group.f.state.close().await;
    let restored = State::open((*cfg).clone()).await.unwrap();
    let store = restored.workspace.get(&wid, &wid).await.unwrap();
    assert_eq!(
        store.get(Table::Messages, &id).await.unwrap().unwrap(),
        expected
    );
    restored.close().await;
    group.close().await;
}
#[tokio::test]
async fn member_unknown_provider_and_model_url_do_not_create_cards() {
    for (member, args) in [
        (
            true,
            json!({"providerId":"notion","reason":"Member request"}),
        ),
        (
            false,
            json!({"providerId":"untrusted","reason":"Unknown provider"}),
        ),
        (
            false,
            json!({"providerId":"notion","reason":"Extra address","url":"https://untrusted.example.test"}),
        ),
        (
            false,
            json!({"providerId":"notion","reason":"x".repeat(301)}),
        ),
    ] {
        let group = Group::new().await;
        let model = Model::new(Arc::new(move |body| {
            let args = args.clone();
            Box::pin(async move {
                assert_eq!(advertised(&body, "suggest_app_connection"), !member);
                assert!(advertised(&body, "list_app_providers"));
                if has_tool_result(&body) {
                    finish("The suggestion was refused.")
                } else {
                    call("suggest_app_connection", args)
                }
            })
        }))
        .await;
        group.configure(&model).await;
        group
            .send("Try a bounded suggestion.", "followUp", member)
            .await;
        assert!(proposals(&group.done().await).is_empty());
        group.close().await;
    }
}

#[tokio::test]
async fn a_member_can_find_an_existing_catalog_connection_without_seeing_private_fields() {
    let group = Group::new().await;
    let (status, connection) = group.f.request("POST", &group.f.path("/apps"), Some(json!({
        "name":"Existing notes","url":"https://mcp.notion.com/mcp/","authType":"oauth","shared":true
    })), false, Some(&group.f.owner)).await;
    assert_eq!(status, 200, "{connection}");
    let id = connection["id"].clone();
    let model = Model::new(Arc::new(move |body| {
        let id = id.clone();
        Box::pin(async move {
            assert!(advertised(&body, "list_app_providers"));
            assert!(!advertised(&body, "suggest_app_connection"));
            if !has_tool_result(&body) {
                lookup("NoTiOn")
            } else {
                assert_eq!(tool_result(&body), json!({"providers":[{
                    "providerId":"notion","name":"Notion","category":"productivity","authType":"oauth",
                    "connectionStatus":"needs_auth","connectionId":id
                }],"hasMore":false}));
                finish("The existing connection needs owner authorization.")
            }
        })
    })).await;
    group.configure(&model).await;
    group
        .send(
            "Find Notion in the official app directory.",
            "followUp",
            true,
        )
        .await;
    let messages = group.done().await;
    assert!(messages.iter().any(|m| m["content"]
        == "The existing connection needs owner authorization."
        && m["status"] == "done"));
    assert!(proposals(&messages).is_empty());
    group.close().await;
}

#[tokio::test]
async fn concurrent_official_presets_share_identity_without_rewriting_generic_paths() {
    let group = Group::new().await;
    let path = group.f.path("/apps");
    let owner = Some(group.f.owner.as_str());
    let request = |name: &str, url: &str| {
        Some(json!({"name":name,"url":url,"authType":"oauth","shared":true}))
    };
    let (first, second) = tokio::join!(
        group.f.request(
            "POST",
            &path,
            request("Notes with slash", "https://mcp.notion.com/mcp/"),
            false,
            owner
        ),
        group.f.request(
            "POST",
            &path,
            request("Notes without slash", "https://mcp.notion.com/mcp"),
            false,
            owner
        ),
    );
    let (saved, refused) = if first.0 == 200 {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(saved.0, 200, "{}", saved.1);
    assert_eq!(refused.0, 409, "{}", refused.1);
    assert_eq!(refused.1["code"], "APP_CONNECTION_EXISTS");
    for (name, url) in [
        ("Generic path", "https://mcp.example.test/services"),
        ("Generic path slash", "https://mcp.example.test/services/"),
    ] {
        let result = group
            .f
            .request("POST", &path, request(name, url), false, owner)
            .await;
        assert_eq!(result.0, 200, "{}", result.1);
        assert_eq!(result.1["url"], url);
    }
    let records = group.f.request("GET", &path, None, false, owner).await.1;
    assert_eq!(records.as_array().unwrap().len(), 3);
    assert_eq!(records[0]["id"], saved.1["id"]);
    group.close().await;
}
#[tokio::test]
async fn child_and_routine_runs_cannot_suggest_connections() {
    let group = Group::new().await;
    let child = group.ids[1].clone();
    let model = Model::new(Arc::new(move |body| {
        let child = child.clone();
        Box::pin(async move {
            if has_tool_result(&body) {
                finish("No connection suggestion from this task.")
            } else if role(&body) == 0 {
                call(
                    "delegate",
                    json!({"agentId":child,"task":"Suggest an application."}),
                )
            } else {
                assert!(!advertised(&body, "list_app_providers"));
                assert!(!advertised(&body, "suggest_app_connection"));
                suggestion()
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Ask the colleague for a focused suggestion.",
            "followUp",
            false,
        )
        .await;
    assert!(proposals(&group.done().await).is_empty());
    let model = Model::new(Arc::new(move |body| {
        Box::pin(async move {
            assert!(!advertised(&body, "list_app_providers"));
            assert!(!advertised(&body, "suggest_app_connection"));
            if has_tool_result(&body) {
                finish("No suggestion from a routine.")
            } else {
                suggestion()
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let (status,routine)=group.f.request("POST",&group.f.path("/routines"),Some(json!({"title":"Synthetic routine","prompt":"Suggest a connection","agentId":group.ids[0],"conversationId":group.cid,"schedule":"daily:09:00","enabled":false})),false,Some(&group.f.owner)).await;
    assert_eq!(status, 201, "{routine}");
    let (status, body) = group
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
    assert_eq!(status, 202, "{body}");
    assert!(proposals(&group.done().await).is_empty());
    group.close().await;
}
#[tokio::test]
async fn revoked_owner_cannot_publish_a_late_suggestion() {
    let group = Group::new().await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (ready, gate) = (entered.clone(), release.clone());
    let model = Model::new(Arc::new(move |_| {
        let (ready, gate) = (ready.clone(), gate.clone());
        Box::pin(async move {
            ready.add_permits(1);
            wait_gate(&gate).await;
            suggestion()
        })
    }))
    .await;
    group.configure(&model).await;
    group.send("Wait, then suggest.", "followUp", false).await;
    wait_gate(&entered).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
        .bind(&group.f.owner)
        .execute(&group.f.db)
        .await
        .unwrap();
    release.add_permits(1);
    assert!(proposals(&group.done().await).is_empty());
    group.close().await;
}
#[tokio::test]
async fn shared_alias_cannot_recommend_source_or_personal_connections() {
    let shared = shared_bots_support::Shared::new().await;
    let joined = shared.add().await;
    let model = Model::new(Arc::new(move |body| {
        Box::pin(async move {
            if has_tool_result(&body) {
                finish("A shared Bot cannot propose an app connection.")
            } else {
                suggestion()
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
    let body = json!({"content":"Suggest a connection.","clientId":uuid::Uuid::new_v4().to_string(),"agentId":joined["agentId"]});
    assert_eq!(
        shared
            .f
            .request(
                "POST",
                &format!(
                    "{prefix}/conversations/{}/messages",
                    joined["conversationId"].as_str().unwrap()
                ),
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
    assert!(proposals(&store.list(Table::Messages).await.unwrap()).is_empty());
    shared.f.close().await;
}
