mod computer_support;
mod teaching_support;
mod workspace_support;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use teaching_support::{Teaching, called, model, proposal};
use tokio::sync::Semaphore;

#[tokio::test]
async fn real_isolated_pi_uses_explicit_profile_and_persists_exactly_one_unapproved_skill() {
    let t = Teaching::new().await;
    let (default_before, bootstrap) = (
        t.f.bootstrap().await["settings"]["profileId"].clone(),
        t.f.bootstrap().await,
    );
    assert_eq!(
        t.input(json!({"type":"type","text":"SYNTHETIC_PASSWORD_NEVER_IN_MODEL"}))
            .await
            .0,
        200
    );
    assert_eq!(
        t.input(json!({"type":"navigate","url":"https://example.test/?token=NEVER_IN_MODEL"}))
            .await
            .0,
        200
    );
    let saved = t.review().await;
    let (task, calls, profile) = model(&t.f, proposal(), None).await;
    assert_eq!(
        t.f.bootstrap().await["settings"]["profileId"],
        default_before
    );
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile});
    let (status, first) = t.request("POST", "/generate", Some(body.clone())).await;
    assert_eq!(status, 200, "{first}");
    let done = t.settled().await;
    assert_eq!(done["status"], "proposed", "{done}");
    let captured = calls.lock().await;
    assert_eq!(captured.len(), 1);
    let text = captured[0].to_string();
    assert!(!text.contains("NEVER_IN_MODEL"));
    assert!(!text.contains("SYNTHETIC_MODEL_CREDENTIAL"));
    assert!(text.contains("Fill the synthetic form field"));
    drop(captured);
    let after = t.f.bootstrap().await;
    let skills = after["skills"].as_array().unwrap();
    assert_eq!(
        skills.len(),
        bootstrap["skills"].as_array().unwrap().len() + 1
    );
    let skill = skills.iter().find(|s| s["id"] == done["skillId"]).unwrap();
    assert_eq!(skill["status"], "proposed");
    let (status, replayed) = t.request("POST", "/generate", Some(body.clone())).await;
    assert_eq!(status, 200);
    assert_eq!(replayed, done);
    assert_eq!(calls.lock().await.len(), 1);
    let mut different = body.clone();
    different["profileId"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(t.request("POST", "/generate", Some(different)).await.0, 409);
    let (status, approved) =
        t.f.request(
            "POST",
            &t.f.path(&format!(
                "/skills/{}/approve",
                done["skillId"].as_str().unwrap()
            )),
            Some(json!({"expectedActiveId":null})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(approved["status"], "active");
    task.abort();
    t.f.close().await;
}
#[tokio::test]
async fn cancelling_generation_reaps_pi_and_fences_retries_and_late_model_output() {
    let t = Teaching::new().await;
    t.input(json!({"type":"key","key":"Enter"})).await;
    let saved = t.review().await;
    let gate = Arc::new(Semaphore::new(0));
    let (task, calls, profile) = model(&t.f, proposal(), Some(gate.clone())).await;
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile});
    assert_eq!(
        t.request("POST", "/generate", Some(body.clone())).await.0,
        200
    );
    called(&calls).await;
    assert_eq!(t.request("POST", "/cancel", Some(json!({}))).await.0, 200);
    gate.add_permits(1);
    let done = t.settled().await;
    assert_eq!(done["status"], "error");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        t.f.bootstrap().await["skills"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(t.request("POST", "/generate", Some(body)).await.0, 200);
    assert_eq!(calls.lock().await.len(), 1);
    assert_eq!(t.read().await["steps"].as_array().unwrap().len(), 1);
    task.abort();
    t.f.close().await;
}
#[tokio::test]
async fn model_format_failure_preserves_reviewed_steps_and_never_enables_or_retries() {
    let t = Teaching::new().await;
    t.input(json!({"type":"key","key":"Enter"})).await;
    let saved = t.review().await;
    let (task, calls, profile) = model(
        &t.f,
        json!({"name":"bad","content":"unfinished","execute":true}),
        None,
    )
    .await;
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile});
    assert_eq!(
        t.request("POST", "/generate", Some(body.clone())).await.0,
        200
    );
    let done = t.settled().await;
    assert_eq!(done["status"], "error");
    assert_eq!(done["steps"], saved["steps"]);
    assert_eq!(calls.lock().await.len(), 1);
    assert_eq!(t.request("POST", "/generate", Some(body)).await.0, 200);
    assert_eq!(calls.lock().await.len(), 1);
    assert!(
        t.f.bootstrap().await["skills"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    task.abort();
    t.f.close().await;
}
#[tokio::test]
async fn cancellation_before_start_or_generation_is_a_persistent_admission_fence() {
    let t = Teaching::new().await;
    let late = uuid::Uuid::new_v4().to_string();
    let path = t.f.path(&format!("/teaching/{late}/cancel"));
    assert_eq!(
        t.f.request("POST", &path, Some(json!({})), false, Some(&t.f.owner))
            .await
            .0,
        200
    );
    t.request("POST", "/stop", Some(json!({}))).await;
    let response=t.f.request("POST",&t.f.path("/teaching"),Some(json!({"requestId":late,"agentId":t.agent,"conversationId":t.conversation,"leaseId":t.lease["leaseId"]})),false,Some(&t.f.owner)).await;
    assert_eq!(response.0, 410, "{}", response.1);
    let (status, value) =
        t.f.request(
            "GET",
            &t.f.path(&format!("/teaching/{late}")),
            None,
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 410, "{value}");
    t.f.close().await;
    let t = Teaching::new().await;
    t.input(json!({"type":"key","key":"Enter"})).await;
    let saved = t.review().await;
    let (task, calls, profile) = model(&t.f, proposal(), None).await;
    t.request("POST", "/cancel", Some(json!({}))).await;
    let response=t.request("POST","/generate",Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":saved["revision"],"profileId":profile}))).await;
    assert_eq!(response.0, 409, "{}", response.1);
    assert!(calls.lock().await.is_empty());
    task.abort();
    t.f.close().await;
}
