mod agent_delegation_support;
mod shared_bots_support;
mod team_builder_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, has_tool_result, role};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::Arc;
use workspace_support::Fixture;

async fn save_model(f: &Fixture, model: &str, url: &str, key: &str) -> String {
    let (status, value) = f
        .request(
            "POST",
            &f.path("/model-profiles"),
            Some(json!({
                "name":model,"provider":"synthetic-routing","model":model,"baseUrl":url,"apiKey":key
            })),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{value}");
    value["profile"]["id"].as_str().unwrap().to_owned()
}

async fn select(f: &Fixture, bot: &str, profile: Value) -> Value {
    let (status, value) = f
        .request(
            "PATCH",
            &f.path(&format!("/agents/{bot}")),
            Some(json!({"modelProfileId":profile})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value
}

#[tokio::test]
async fn bot_model_reference_is_local_configured_revisioned_and_can_be_cleared() {
    let mut f = Fixture::new().await;
    let selected = save_model(
        &f,
        "specialist",
        "https://model.example.test/v1",
        "SYNTHETIC_BOT_MODEL_KEY",
    )
    .await;
    let (status, bot) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(json!({
                "name":"Model specialist", "modelProfileId":selected
            })),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{bot}");
    assert_eq!(bot["modelProfileId"], selected);
    let bot_id = bot["id"].as_str().unwrap();
    assert!(!bot.to_string().contains("SYNTHETIC_BOT_MODEL_KEY"));
    assert!(bot.get("apiKey").is_none());
    let (status, unchanged) = f
        .request(
            "PATCH",
            &f.path(&format!("/agents/{bot_id}")),
            Some(json!({"name":"Renamed specialist"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(unchanged["modelProfileId"], selected);
    let deleted = f
        .request(
            "DELETE",
            &f.path(&format!("/model-profiles/{selected}")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(deleted.0, 409);
    assert_eq!(deleted.1["code"], "MODEL_PROFILE_IN_USE");
    for invalid in [
        json!(true),
        json!("not-an-id"),
        json!({"apiKey":"synthetic"}),
    ] {
        let r = f
            .request(
                "PATCH",
                &f.path(&format!("/agents/{bot_id}")),
                Some(json!({"modelProfileId":invalid})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(r.0, 400, "{}", r.1);
    }
    let unconfigured = save_model(&f, "not-configured", "", "").await;
    let r = f
        .request(
            "PATCH",
            &f.path(&format!("/agents/{bot_id}")),
            Some(json!({"modelProfileId":unconfigured})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(r.0, 400, "{}", r.1);
    let foreign = f.request("POST", &format!("/api/workspaces/{}/model-profiles", f.foreign), Some(json!({
        "name":"Foreign model","provider":"synthetic-routing","model":"foreign","baseUrl":"https://foreign.example.test/v1"
    })), true, Some(&f.member)).await;
    assert_eq!(foreign.0, 201, "{}", foreign.1);
    let r = f
        .request(
            "PATCH",
            &f.path(&format!("/agents/{bot_id}")),
            Some(json!({"modelProfileId":foreign.1["profile"]["id"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(r.0, 404, "{}", r.1);
    let r = f
        .request(
            "PATCH",
            &f.path(&format!("/agents/{bot_id}")),
            Some(json!({"modelProfileId":Value::Null})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(r.0, 403);
    let boot = f.bootstrap().await;
    assert_eq!(
        boot["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == bot_id)
            .unwrap()["modelProfileId"],
        selected
    );
    assert_eq!(boot["settings"]["configured"], false);
    assert_eq!(
        boot["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|agent| agent["id"] == bot_id)
            .unwrap()["modelConfigured"],
        true
    );
    assert!(!boot.to_string().contains("SYNTHETIC_BOT_MODEL_KEY"));
    f.state.close().await;
    f.state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        f.directory.path(),
    ))
    .await
    .unwrap();
    let restarted = f.bootstrap().await;
    let persisted = restarted["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == bot_id)
        .unwrap();
    assert_eq!(persisted["modelProfileId"], selected);
    assert_eq!(persisted["modelConfigured"], true);
    let cleared = select(&f, bot_id, Value::Null).await;
    assert!(cleared["modelProfileId"].is_null());
    assert_ne!(cleared["configRevision"], unchanged["configRevision"]);
    assert_eq!(
        f.request(
            "DELETE",
            &f.path(&format!("/model-profiles/{selected}")),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    f.close().await;
}

#[tokio::test]
async fn real_pi_routes_each_delegated_bot_and_usage_to_its_own_model_then_inherits_when_cleared() {
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let model = Model::new(Arc::new(move |body| {
        let target = target.clone();
        Box::pin(async move {
            match (role(&body), has_tool_result(&body)) {
                (0, false) => call(
                    "delegate",
                    json!({"agentId":target,"task":"Return a synthetic specialist result."}),
                ),
                (1, _) => finish("Synthetic specialist result."),
                (0, true) => finish("Synthetic coordinated result."),
                _ => panic!("Unexpected synthetic role"),
            }
        })
    }))
    .await;
    g.configure(&model).await;
    let selected = save_model(
        &g.f,
        "specialist-model",
        &model.url,
        "SYNTHETIC_SPECIALIST_KEY",
    )
    .await;
    select(&g.f, &g.ids[1], json!(selected)).await;
    g.send("Coordinate the synthetic task.", "followUp", false)
        .await;
    let messages = g.done().await;
    assert!(
        messages
            .iter()
            .any(|m| m["agentId"] == g.ids[1] && m["status"] == "done")
    );
    let records = model.calls.lock().await;
    let auth = model.authorization.lock().await;
    assert_eq!(records.len(), 3);
    for (body, credential) in records.iter().zip(auth.iter()) {
        if role(body) == 1 {
            assert_eq!(body["model"], "specialist-model");
            assert_eq!(credential, "Bearer SYNTHETIC_SPECIALIST_KEY");
        } else {
            assert_eq!(body["model"], "fixture");
            assert_eq!(credential, "Bearer SYNTHETIC_DELEGATION_KEY");
        }
    }
    drop(auth);
    drop(records);
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT agent_id,model,profile_id FROM model_usage ORDER BY created_at")
            .fetch_all(&g.store.pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|(bot, model, profile)| bot == &g.ids[1]
        && model == "specialist-model"
        && profile == &selected));
    assert!(
        rows.iter()
            .filter(|(bot, _, _)| bot == &g.ids[0])
            .all(|(_, model, profile)| model == "fixture" && profile != &selected)
    );
    select(&g.f, &g.ids[1], Value::Null).await;
    g.send("Coordinate the next synthetic task.", "followUp", false)
        .await;
    g.done().await;
    let records = model.calls.lock().await;
    assert_eq!(records.len(), 6);
    assert!(records[3..].iter().all(|body| body["model"] == "fixture"));
    assert!(
        model.authorization.lock().await[3..]
            .iter()
            .all(|key| key == "Bearer SYNTHETIC_DELEGATION_KEY")
    );
    drop(records);
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn scheduled_bot_runs_with_its_model_when_workspace_default_is_unconfigured() {
    let g = Group::new().await;
    let model = Model::new(Arc::new(|_| {
        Box::pin(async { finish("Synthetic scheduled result.") })
    }))
    .await;
    let selected = save_model(
        &g.f,
        "scheduled-specialist",
        &model.url,
        "SYNTHETIC_SCHEDULED_KEY",
    )
    .await;
    select(&g.f, &g.ids[0], json!(selected)).await;
    let r =
        g.f.request(
            "POST",
            &g.f.path("/routines"),
            Some(json!({
                "agentId":g.ids[0],"conversationId":g.cid,"title":"Synthetic schedule",
                "prompt":"Return a synthetic result.","schedule":"daily:09:00","enabled":true
            })),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(r.0, 201, "{}", r.1);
    let mut routine = r.1;
    let at = chrono::Utc::now().timestamp_millis();
    routine["nextRunAt"] = json!(
        chrono::DateTime::from_timestamp_millis(at - 1000)
            .unwrap()
            .to_rfc3339()
    );
    g.store.put(Table::Routines, &routine).await.unwrap();
    openbot_backend::scheduling::tick(&g.f.state, at)
        .await
        .unwrap();
    let messages = g.done().await;
    assert!(
        messages
            .iter()
            .any(|m| m["agentId"] == g.ids[0] && m["status"] == "done"),
        "{messages:?}"
    );
    let records = model.calls.lock().await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["model"], "scheduled-specialist");
    assert_eq!(
        model.authorization.lock().await[0],
        "Bearer SYNTHETIC_SCHEDULED_KEY"
    );
    drop(records);
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn human_team_draft_keeps_workspace_model_selection_through_atomic_creation() {
    let f = Fixture::new().await;
    let selected = save_model(&f, "team-specialist", "https://model.example.test/v1", "").await;
    let mut draft = team_builder_support::proposal();
    draft["members"][1]["modelProfileId"] = json!(selected);
    let plan = team_builder_support::seed(&f, draft).await;
    let r = f
        .request(
            "POST",
            &f.path(&format!(
                "/bot-team-plans/{}/commit",
                plan["id"].as_str().unwrap()
            )),
            Some(team_builder_support::commit(&plan)),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(r.0, 200, "{}", r.1);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let agents = store.list(Table::Agents).await.unwrap();
    assert_eq!(
        agents
            .iter()
            .find(|agent| agent["name"] == "Check")
            .unwrap()["modelProfileId"],
        selected
    );
    assert!(
        agents
            .iter()
            .find(|agent| agent["name"] == "Research")
            .unwrap()["modelProfileId"]
            .is_null()
    );
    f.close().await;
}

#[tokio::test]
async fn shared_bot_uses_recipient_default_instead_of_source_or_coordinator_override() {
    let s = shared_bots_support::Shared::new().await;
    let mut source = s
        .source
        .get(Table::Agents, &s.agent)
        .await
        .unwrap()
        .unwrap();
    source["instructions"] = json!("SYNTHETIC_ROLE_1: Return the assigned result.");
    s.source.put(Table::Agents, &source).await.unwrap();
    let joined = s.add().await;
    let alias = joined["agentId"].as_str().unwrap().to_owned();
    let target = alias.clone();
    let model = Model::new(Arc::new(move |body| {
        let target = target.clone();
        Box::pin(async move {
            match (role(&body), has_tool_result(&body)) {
                (0, false) => call(
                    "delegate",
                    json!({"agentId":target,"task":"Return a synthetic shared result."}),
                ),
                (1, _) => finish("Synthetic shared result."),
                (0, true) => finish("Synthetic synthesis."),
                _ => panic!("Unexpected synthetic role"),
            }
        })
    }))
    .await;
    let source_config =
        s.f.request(
            "POST",
            &s.f.path("/model-profiles"),
            Some(json!({
                "name":"Source model","provider":"synthetic-routing","model":"source-only-model",
                "baseUrl":model.url,"apiKey":"SYNTHETIC_SOURCE_ONLY_KEY"
            })),
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(source_config.0, 201, "{}", source_config.1);
    let source_model = source_config.1["profile"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let configured =
        s.f.request(
            "PATCH",
            &s.f.path(&format!("/agents/{}", s.agent)),
            Some(json!({"modelProfileId":source_model})),
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(configured.0, 200, "{}", configured.1);
    let prefix = format!("/api/workspaces/{}", s.personal);
    let default =
        s.f.request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(model.config()),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(default.0, 200, "{}", default.1);
    let selected = s.f.request("POST", &format!("{prefix}/model-profiles"), Some(json!({
        "name":"Recipient coordinator","provider":"synthetic-routing","model":"coordinator-model",
        "baseUrl":model.url,"apiKey":"SYNTHETIC_COORDINATOR_KEY"
    })), true, Some(&s.f.member)).await;
    assert_eq!(selected.0, 201, "{}", selected.1);
    let root = s.f.request("POST", &format!("{prefix}/agents"), Some(json!({
        "name":"Recipient coordinator","instructions":"SYNTHETIC_ROLE_0: Coordinate the task.",
        "modelProfileId":selected.1["profile"]["id"]
    })), true, Some(&s.f.member)).await;
    assert_eq!(root.0, 201, "{}", root.1);
    let aid = root.1["id"].as_str().unwrap();
    let chat =
        s.f.request(
            "POST",
            &format!("{prefix}/conversations"),
            Some(json!({
                "title":"Synthetic shared team","agentIds":[aid,alias],"isGroup":true
            })),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(chat.0, 201, "{}", chat.1);
    let cid = chat.1["id"].as_str().unwrap();
    let r = s.f.request("POST", &format!("{prefix}/conversations/{cid}/messages"), Some(json!({
        "clientId":shared_bots_support::id(),"agentId":aid,"content":"Delegate the synthetic task.","mode":"followUp"
    })), true, Some(&s.f.member)).await;
    assert_eq!(r.0, 202, "{}", r.1);
    tokio::time::timeout(std::time::Duration::from_secs(35), async {
        while !s.f.state.agent_runs.requests(&s.personal).await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Shared model routing did not finish");
    let records = model.calls.lock().await;
    let auth = model.authorization.lock().await;
    assert_eq!(records.len(), 3);
    for (body, key) in records.iter().zip(auth.iter()) {
        if role(body) == 1 {
            assert_eq!(body["model"], "fixture");
            assert_eq!(key, "Bearer SYNTHETIC_DELEGATION_KEY");
        } else {
            assert_eq!(body["model"], "coordinator-model");
            assert_eq!(key, "Bearer SYNTHETIC_COORDINATOR_KEY");
        }
        assert!(!body.to_string().contains("SYNTHETIC_SOURCE_ONLY_KEY"));
        assert!(!body.to_string().contains(&source_model));
    }
    drop(auth);
    drop(records);
    drop(model);
    s.close().await;
}
