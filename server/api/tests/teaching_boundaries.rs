mod computer_support;
mod teaching_support;
mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use teaching_support::{Teaching, called, model, proposal};
use tokio::sync::Semaphore;

async fn persisted(t: &Teaching) -> Value {
    let store =
        t.f.state
            .workspace
            .get(&t.f.workspace, &t.f.workspace)
            .await
            .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM teaching_sessions WHERE id=?")
        .bind(t.session["id"].as_str().unwrap())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}
async fn failed(t: &Teaching) -> Value {
    for _ in 0..150 {
        let saved = persisted(t).await;
        if saved["status"] != "generating" {
            return saved;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("Generation did not stop after access changed");
}
#[tokio::test]
async fn revoked_owner_session_cancels_an_actual_model_request_and_never_commits_a_skill() {
    let t = Teaching::new().await;
    t.input(json!({"type":"key","key":"Enter"})).await;
    let saved = t.review().await;
    let gate = Arc::new(Semaphore::new(0));
    let (task, calls, profile) = model(&t.f, proposal(), Some(gate.clone())).await;
    assert_eq!(t.request("POST","/generate",Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile}))).await.0,200);
    called(&calls).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
        .bind(&t.f.owner)
        .execute(&t.f.db)
        .await
        .unwrap();
    let terminal = failed(&t).await;
    assert_eq!(terminal["status"], "error");
    assert_eq!(terminal["steps"], saved["steps"]);
    gate.add_permits(1);
    let ws =
        t.f.state
            .workspace
            .get(&t.f.workspace, &t.f.workspace)
            .await
            .unwrap();
    assert!(ws.list(Table::Skills).await.unwrap().is_empty());
    assert_eq!(calls.lock().await.len(), 1);
    assert!(matches!(t.request("GET", "", None).await.0, 401 | 403));
    task.abort();
    tokio::time::timeout(Duration::from_secs(5), t.f.close())
        .await
        .unwrap();
}
#[tokio::test]
async fn changing_the_selected_model_while_generating_fences_the_late_result() {
    let t = Teaching::new().await;
    t.input(json!({"type":"key","key":"Enter"})).await;
    let saved = t.review().await;
    let gate = Arc::new(Semaphore::new(0));
    let (task, calls, profile) = model(&t.f, proposal(), Some(gate.clone())).await;
    assert_eq!(t.request("POST","/generate",Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile}))).await.0,200);
    called(&calls).await;
    let(status,body)=t.f.request("POST",&t.f.path("/model-profiles"),Some(json!({"id":profile,"name":"Changed selected profile","provider":"teaching-fixture","model":"changed-fixture","activate":false})),false,Some(&t.f.owner)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(failed(&t).await["status"], "error");
    gate.add_permits(1);
    assert!(
        t.f.bootstrap().await["skills"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(calls.lock().await.len(), 1);
    task.abort();
    t.f.close().await;
}
#[tokio::test]
async fn sixty_real_inputs_stop_recording_and_partial_generation_requires_explicit_confirmation() {
    let t = Teaching::new().await;
    for _ in 0..60 {
        assert_eq!(t.input(json!({"type":"key","key":"Enter"})).await.0, 200);
    }
    let stopped = t.settled().await;
    assert_eq!(stopped["status"], "interrupted");
    assert_eq!(stopped["reason"], "step_limit");
    assert_eq!(stopped["steps"].as_array().unwrap().len(), 60);
    let(saved_status,saved)=t.request("PATCH","",Some(json!({"expectedRevision":stopped["revision"],"goal":"Use this partial form demonstration","steps":[{"id":stopped["steps"][0]["id"],"note":"Use a placeholder"}]}))).await;
    assert_eq!(saved_status, 200, "{saved}");
    let (task, calls, profile) = model(&t.f, proposal(), None).await;
    let mut body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile});
    assert_eq!(
        t.request("POST", "/generate", Some(body.clone())).await.0,
        409
    );
    assert!(calls.lock().await.is_empty());
    body["acceptInterrupted"] = json!(true);
    assert_eq!(t.request("POST", "/generate", Some(body)).await.0, 200);
    assert_eq!(t.settled().await["status"], "proposed");
    assert_eq!(calls.lock().await.len(), 1);
    task.abort();
    t.f.close().await;
}

#[tokio::test]
async fn the_same_client_request_id_in_two_spaces_cannot_replace_the_other_live_recording() {
    let mut t = Teaching::new().await;
    let original_space = t.f.workspace.clone();
    let original_id = t.session["id"].as_str().unwrap().to_owned();
    sqlx::query("UPDATE memberships SET user_id=? WHERE workspace_id=? AND role='owner'")
        .bind(&t.f.owner)
        .bind(&t.f.foreign)
        .execute(&t.f.db)
        .await
        .unwrap();
    t.f.workspace = t.f.foreign.clone();
    let bootstrap = t.f.bootstrap().await;
    let agent = bootstrap["agents"][0]["id"].as_str().unwrap();
    let conversation = bootstrap["conversations"][0]["id"].as_str().unwrap();
    let peer = computer_support::Server::start(&t.f.workspace).await;
    computer_support::connect(&t.f, &peer.worker).await;
    computer_support::prepared(&t.f, agent).await;
    let (status, lease) =
        t.f.request(
            "POST",
            &t.f.path(&format!("/computer/bots/{agent}/takeover/start")),
            Some(json!({})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{lease}");
    let (status, saved) = t.f.request("POST", &t.f.path("/teaching"), Some(json!({"requestId":original_id,"agentId":agent,"conversationId":conversation,"leaseId":lease["leaseId"]})), false, Some(&t.f.owner)).await;
    assert_eq!(status, 200, "{saved}");
    let original =
        t.f.state
            .teaching
            .get(&original_space, &original_id)
            .unwrap();
    let second =
        t.f.state
            .teaching
            .get(&t.f.workspace, &original_id)
            .unwrap();
    assert!(!Arc::ptr_eq(&original, &second));
    let (status, _) =
        t.f.request(
            "POST",
            &t.f.path(&format!("/teaching/{original_id}/cancel")),
            Some(json!({})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200);
    let (status, value) =
        t.f.request(
            "GET",
            &format!("/api/workspaces/{original_space}/teaching/{original_id}"),
            None,
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "recording");
    let (status, value) =
        t.f.request(
            "POST",
            &format!(
                "/api/workspaces/{original_space}/computer/bots/{}/takeover/input",
                t.agent
            ),
            Some(json!({"type":"key","key":"Enter","leaseId":t.lease["leaseId"]})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    t.f.close().await;
}
