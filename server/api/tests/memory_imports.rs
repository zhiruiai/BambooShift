mod agent_queue_support;
mod memory_import_support;
mod workspace_support;
use memory_import_support::*;
use openbot_backend::{config::Config, db::State, workspace::Table};
use serde_json::json;

#[tokio::test]
async fn readiness_is_personal_and_requires_a_primary_and_a_model() {
    let team = Fixture::new().await;
    let ready = team
        .request(
            "GET",
            &team.path("/memory-imports"),
            None,
            true,
            Some(&team.member),
        )
        .await;
    assert_eq!(ready.0, 200);
    assert_eq!(ready.1["available"], false);
    assert_eq!(ready.1["reason"], "personal_required");
    team.close().await;
    let f = personal().await;
    assert_eq!(
        f.request(
            "GET",
            &f.path("/memory-imports"),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .1["reason"],
        "primary_required"
    );
    let p = primary(&f).await;
    assert_eq!(
        f.request(
            "GET",
            &f.path("/memory-imports"),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .1["reason"],
        "model_required"
    );
    let body = request(&p);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/memory-imports"),
            Some(body.clone()),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    for (cookie, expected) in [
        (
            format!("openbot_account={}", f.member_token),
            Some(f.member.as_str()),
        ),
        (
            format!("openbot_account={}", f.owner_token),
            Some(f.member.as_str()),
        ),
        (format!("openbot_account={}", f.owner_token), None),
        (
            format!("openbot_operator={}", f.operator_token),
            Some(f.owner.as_str()),
        ),
    ] {
        assert!(
            [401, 403].contains(
                &f.with_cookie(
                    "POST",
                    &f.path("/memory-imports"),
                    Some(body.clone()),
                    &cookie,
                    expected
                )
                .await
                .0
            )
        );
    }
    let store = store(&f).await;
    assert_eq!(count_inputs(&store).await, 0);
    f.close().await;
}
#[tokio::test]
async fn actual_pi_batches_memories_with_private_source_and_repeat_never_dispatches() {
    let f = personal().await;
    let p = primary(&f).await;
    let model = Model::new(&f).await;
    let body = request(&p);
    let id = body["requestId"].as_str().unwrap();
    let path = f.path("/memory-imports");
    let (a, b) = tokio::join!(
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner)),
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner))
    );
    assert!([200, 202].contains(&a.0), "{}", a.1);
    assert!([200, 202].contains(&b.0), "{}", b.1);
    assert_eq!(a.1["messageId"], b.1["messageId"]);
    let receipt = wait(&f, id).await;
    assert_eq!(receipt["status"], "completed", "{receipt}");
    let store = store(&f).await;
    assert_eq!(count_inputs(&store).await, 1);
    assert_eq!(store.list(Table::Memories).await.unwrap().len(), 2);
    let records = model.calls.lock().await;
    assert_eq!(records.len(), 2);
    let tools = records[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(tools, vec!["remember", "recall"]);
    assert!(records[0].to_string().contains("PRIVATE_SOURCE_WRAPPER"));
    drop(records);
    for table in ["messages", "settings", "memory_imports"] {
        let rows: Vec<String> = sqlx::query_scalar(&format!("SELECT data FROM {table}"))
            .fetch_all(&store.pool)
            .await
            .unwrap();
        assert!(
            rows.iter().all(|v| !v.contains("PRIVATE_SOURCE_WRAPPER")),
            "source persisted in {table}"
        );
    }
    assert_eq!(
        f.request(
            "PUT",
            &f.path("/primary-bot"),
            Some(json!({"mode":"clear","expectedRevision":p["revision"]})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner))
            .await
            .1,
        receipt
    );
    assert_eq!(model.calls.lock().await.len(), 2);
    let mut changed = body.clone();
    changed["content"] = json!("Different source");
    assert_eq!(
        f.request("POST", &path, Some(changed), false, Some(&f.owner))
            .await
            .0,
        409
    );
    store
        .delete(Table::Conversations, p["conversationId"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        memory_import_support::receipt(&f, id).await.1["status"],
        "missing"
    );
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn receipt_write_failure_rolls_back_input_and_stops_pre_dispatch() {
    let f = personal().await;
    let p = primary(&f).await;
    let model = Model::new(&f).await;
    let store = store(&f).await;
    sqlx::query("CREATE TRIGGER fail_import BEFORE INSERT ON memory_imports BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").execute(&store.pool).await.unwrap();
    assert_eq!(
        f.request(
            "POST",
            &f.path("/memory-imports"),
            Some(request(&p)),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        500
    );
    assert_eq!(count_inputs(&store).await, 0);
    assert_eq!(model.calls.lock().await.len(), 0);
    assert_eq!(
        store
            .get(Table::Agents, p["agentId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["status"],
        "idle"
    );
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn source_and_revision_validation_never_write_on_invalid_input() {
    let f = personal().await;
    let p = primary(&f).await;
    let model = Model::new(&f).await;
    let base = request(&p);
    for (key, value, status) in [
        ("content", json!("a".repeat(16001)), 413),
        ("content", json!("\0"), 400),
        ("content", json!(" "), 400),
        (
            "expectedPrimaryRevision",
            json!(uuid::Uuid::new_v4().to_string()),
            409,
        ),
        ("agentId", p["agentId"].clone(), 400),
    ] {
        let mut body = base.clone();
        body[key] = value;
        let response = f
            .request(
                "POST",
                &f.path("/memory-imports"),
                Some(body),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(response.0, status, "{}", response.1);
    }
    assert_eq!(model.calls.lock().await.len(), 0);
    let local_store = store(&f).await;
    assert_eq!(count_inputs(local_store.as_ref()).await, 0);
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn waiting_import_preserves_private_prompt_in_memory_and_never_steers_a_normal_root() {
    let f = personal().await;
    let p = primary(&f).await;
    let model = agent_queue_support::Model::new(&f).await;
    let cid = p["conversationId"].as_str().unwrap();
    agent_queue_support::submit(&f, cid, "NORMAL_ONLY_MARKER", "followUp", false).await;
    model.wait().await;
    let body = request(&p);
    let accepted = f
        .request(
            "POST",
            &f.path("/memory-imports"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(accepted.0, 202, "{}", accepted.1);
    assert_eq!(model.calls.lock().await.len(), 1);
    let store = store(&f).await;
    assert!(
        store
            .list(Table::Messages)
            .await
            .unwrap()
            .iter()
            .all(|m| !m.to_string().contains("PRIVATE_SOURCE_WRAPPER"))
    );
    model.release.add_permits(1);
    let receipt = wait(&f, body["requestId"].as_str().unwrap()).await;
    assert_eq!(receipt["status"], "completed", "{receipt}");
    let calls = model.calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert!(!calls[0].to_string().contains("PRIVATE_SOURCE_WRAPPER"));
    assert!(calls[1].to_string().contains("PRIVATE_SOURCE_WRAPPER"));
    assert!(!calls[1].to_string().contains("NORMAL_ONLY_MARKER"));
    drop(calls);
    assert!(
        store
            .list(Table::Messages)
            .await
            .unwrap()
            .iter()
            .all(|m| m.get("executionPrompt").is_none())
    );
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn primary_change_cancels_the_import_and_recovery_does_not_reimport() {
    let mut f = personal().await;
    let p = primary(&f).await;
    let model = agent_queue_support::Model::new(&f).await;
    let body = request(&p);
    let id = body["requestId"].as_str().unwrap();
    let accepted = f
        .request(
            "POST",
            &f.path("/memory-imports"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(accepted.0, 202, "{}", accepted.1);
    model.wait().await;
    assert_eq!(
        f.request(
            "PUT",
            &f.path("/primary-bot"),
            Some(json!({"mode":"clear","expectedRevision":p["revision"]})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    let ended = wait(&f, id).await;
    assert_ne!(ended["status"], "completed");
    assert_eq!(model.calls.lock().await.len(), 1);
    let store = store(&f).await;
    let mut uncertain = ended.clone();
    uncertain["status"] = json!("running");
    sqlx::query("UPDATE memory_imports SET data=? WHERE request_id=?")
        .bind(uncertain.to_string())
        .bind(id)
        .execute(&store.pool)
        .await
        .unwrap();
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    assert_eq!(
        memory_import_support::receipt(&f, id).await.1["status"],
        "interrupted"
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/memory-imports"),
            Some(body.clone()),
            false,
            Some(&f.owner)
        )
        .await
        .1["status"],
        "interrupted"
    );
    assert_eq!(model.calls.lock().await.len(), 1);
    drop(model);
    f.close().await;
}
