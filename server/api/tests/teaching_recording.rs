mod computer_support;
mod teaching_support;
mod workspace_support;
use serde_json::json;
use std::sync::atomic::Ordering;
use teaching_support::Teaching;

#[tokio::test]
async fn actual_successful_inputs_are_recorded_without_text_credentials_or_query_strings() {
    let t = Teaching::new().await;
    assert_eq!(t.input(json!({"type":"click","x":40,"y":80})).await.0, 200);
    assert_eq!(
        t.input(json!({"type":"type","text":"SYNTHETIC_PASSWORD_NEVER_RECORD"}))
            .await
            .0,
        200
    );
    assert_eq!(t.input(json!({"type":"navigate","url":"https://example.test/form?token=SECRET_QUERY#SECRET_FRAGMENT"})).await.0,200);
    let failed = t.input(json!({"type":"click","x":999999,"y":10})).await;
    assert_eq!(failed.0, 400);
    let saved = t.read().await;
    assert_eq!(saved["steps"].as_array().unwrap().len(), 3);
    assert_eq!(saved["steps"][1]["action"], "type");
    assert_eq!(
        saved["steps"][2]["details"]["destination"],
        "https://example.test"
    );
    assert!(!saved.to_string().contains("SYNTHETIC_PASSWORD"));
    assert!(!saved.to_string().contains("SECRET_"));
    assert!(saved.get("sessionId").is_none());
    assert!(saved.get("leaseId").is_none());
    let ws =
        t.f.state
            .workspace
            .get(&t.f.workspace, &t.f.workspace)
            .await
            .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM teaching_sessions")
        .fetch_one(&ws.pool)
        .await
        .unwrap();
    assert!(!raw.contains("SYNTHETIC_PASSWORD"));
    assert!(!raw.contains("SECRET_"));
    let review = t.review().await;
    assert_eq!(review["status"], "review");
    let(status,edited)=t.request("PATCH","",Some(json!({"expectedRevision":review["revision"],"goal":"Short version","steps":[{"id":review["steps"][1]["id"],"note":"Use a placeholder"}]}))).await;
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["steps"].as_array().unwrap().len(), 1);
    let conflict = t
        .request(
            "PATCH",
            "",
            Some(json!({"expectedRevision":review["revision"],"goal":"stale","steps":[]})),
        )
        .await;
    assert_eq!(conflict.0, 409);
    assert_eq!(t.read().await, edited);
    t.f.close().await;
}
#[tokio::test]
async fn owner_session_and_workspace_are_required_and_shared_bots_cannot_be_taught() {
    let t = Teaching::new().await;
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"agentId":t.agent,"conversationId":t.conversation,"leaseId":t.lease["leaseId"]});
    for (member, expected) in [
        (false, None),
        (false, Some(t.f.member.as_str())),
        (true, Some(t.f.member.as_str())),
    ] {
        assert_eq!(
            t.f.request(
                "POST",
                &t.f.path("/teaching"),
                Some(body.clone()),
                member,
                expected
            )
            .await
            .0,
            403
        );
    }
    assert_eq!(
        t.f.request(
            "GET",
            &format!(
                "/api/workspaces/{}/teaching/{}",
                t.f.foreign,
                t.session["id"].as_str().unwrap()
            ),
            None,
            false,
            Some(&t.f.owner)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        t.f.request(
            "POST",
            &t.f.path("/teaching"),
            Some(body.clone()),
            false,
            Some(&t.f.owner)
        )
        .await
        .0,
        409
    );
    t.request("POST", "/stop", Some(json!({}))).await;
    let ws =
        t.f.state
            .workspace
            .get(&t.f.workspace, &t.f.workspace)
            .await
            .unwrap();
    let mut bot = ws
        .get(openbot_backend::workspace::Table::Agents, &t.agent)
        .await
        .unwrap()
        .unwrap();
    bot["sharedBot"] = json!({"status":"active"});
    ws.put(openbot_backend::workspace::Table::Agents, &bot)
        .await
        .unwrap();
    assert_eq!(
        t.f.request(
            "POST",
            &t.f.path("/teaching"),
            Some(body),
            false,
            Some(&t.f.owner)
        )
        .await
        .0,
        403
    );
    t.f.close().await;
}
#[tokio::test]
async fn worker_failure_and_scope_generation_change_cannot_produce_a_completed_recording() {
    let t = Teaching::new().await;
    t.worker.worker.cleanup_ok.store(false, Ordering::SeqCst);
    let failed = t
        .input(json!({"type":"type","text":"SECRET_FAILURE"}))
        .await;
    assert_ne!(failed.0, 200);
    let value = t.settled().await;
    assert_eq!(value["status"], "interrupted");
    assert_eq!(value["steps"].as_array().unwrap().len(), 0);
    assert!(!value.to_string().contains("SECRET_FAILURE"));
    t.f.close().await;
    let t = Teaching::new().await;
    t.worker.worker.screens.lock().await[0]["revision"] = json!(uuid::Uuid::new_v4().to_string());
    assert_ne!(t.input(json!({"type":"click","x":40,"y":40})).await.0, 200);
    assert_eq!(t.settled().await["status"], "interrupted");
    t.f.close().await;
}
#[tokio::test]
async fn admitted_work_and_session_revocation_interrupt_without_replaying_inputs() {
    let t = Teaching::new().await;
    assert_eq!(t.input(json!({"type":"key","key":"Enter"})).await.0, 200);
    t.f.state.teaching.interrupt_bot(&t.f.workspace, &t.agent);
    let value = t.settled().await;
    assert_eq!(value["status"], "interrupted");
    assert_eq!(value["reason"], "bot_started_work");
    let before = t
        .worker
        .worker
        .calls
        .lock()
        .await
        .iter()
        .filter(|(path, _)| path.ends_with("/takeover/input"))
        .count();
    t.read().await;
    t.read().await;
    assert_eq!(
        before,
        t.worker
            .worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(path, _)| path.ends_with("/takeover/input"))
            .count()
    );
    t.f.close().await;
    let t = Teaching::new().await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
        .bind(&t.f.owner)
        .execute(&t.f.db)
        .await
        .unwrap();
    for _ in 0..100 {
        let ws =
            t.f.state
                .workspace
                .get(&t.f.workspace, &t.f.workspace)
                .await
                .unwrap();
        let raw: String = sqlx::query_scalar("SELECT data FROM teaching_sessions")
            .fetch_one(&ws.pool)
            .await
            .unwrap();
        if serde_json::from_str::<serde_json::Value>(&raw).unwrap()["status"] == "interrupted" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let ws =
        t.f.state
            .workspace
            .get(&t.f.workspace, &t.f.workspace)
            .await
            .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM teaching_sessions")
        .fetch_one(&ws.pool)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["status"],
        "interrupted"
    );
    t.f.close().await;
}
