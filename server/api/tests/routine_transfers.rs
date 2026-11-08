mod routine_transfer_support;
mod scheduling_support;
mod workspace_support;
use openbot_backend::{db::State, workspace::Table};
use routine_transfer_support::{Transfer, idle};
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn transfer_keeps_identity_schedule_and_real_pi_history_then_future_run_uses_the_receiver() {
    let mut t = Transfer::new().await;
    let model = scheduling_support::Model::new(&t.f).await;
    let path = t.f.path(&format!(
        "/routines/{}/run",
        t.routine["id"].as_str().unwrap()
    ));
    assert_eq!(
        t.f.request("POST", &path, None, false, Some(&t.f.owner))
            .await
            .0,
        202
    );
    idle(&t.f).await;
    t.routine = t.current().await;
    let history_path = t.f.path(&format!(
        "/routines/{}/runs",
        t.routine["id"].as_str().unwrap()
    ));
    let (_, old_history) =
        t.f.request("GET", &history_path, None, false, Some(&t.f.owner))
            .await;
    assert_eq!(old_history["runs"].as_array().unwrap().len(), 1);
    assert_eq!(old_history["runs"][0]["status"], "completed");
    let body = t.body();
    let (status, receipt) = t.send(&body).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], "transferred");
    let transferred = t.current().await;
    for key in [
        "id",
        "title",
        "prompt",
        "schedule",
        "timeZone",
        "enabled",
        "nextRunAt",
        "lastRunAt",
    ] {
        assert_eq!(transferred[key], t.routine[key], "{key}");
    }
    assert_eq!(transferred["agentId"], t.target["id"]);
    assert_eq!(transferred["conversationId"], t.chat["id"]);
    assert_eq!(
        t.f.request("GET", &history_path, None, false, Some(&t.f.owner))
            .await
            .1,
        old_history
    );
    assert_eq!(t.get(body["requestId"].as_str().unwrap()).await.1, receipt);
    assert_eq!(t.send(&body).await.1, receipt);
    assert_eq!(
        t.cancel(body["requestId"].as_str().unwrap()).await.1,
        receipt
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        t.f.request("POST", &path, None, false, Some(&t.f.owner))
            .await
            .0,
        202
    );
    idle(&t.f).await;
    let (_, history) =
        t.f.request("GET", &history_path, None, false, Some(&t.f.owner))
            .await;
    assert_eq!(history["runs"].as_array().unwrap().len(), 2);
    assert_eq!(history["runs"][0]["agentId"], t.target["id"]);
    assert_eq!(history["runs"][0]["conversationId"], t.chat["id"]);
    assert_eq!(history["runs"][0]["status"], "completed");
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    t.f.close().await;
}
#[tokio::test]
async fn paused_state_lost_response_restart_and_deleted_routine_are_never_recreated() {
    let mut t = Transfer::new().await;
    let ws = t.store().await;
    t.routine["enabled"] = json!(false);
    ws.put(Table::Routines, &t.routine).await.unwrap();
    let body = t.body();
    let (status, first) = t.send(&body).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["routine"]["enabled"], false);
    assert_eq!(first["routine"]["nextRunAt"], t.routine["nextRunAt"]);
    let config = (*t.f.state.config).clone();
    t.f.state.close().await;
    t.f.state = State::open(config).await.unwrap();
    let id = body["requestId"].as_str().unwrap();
    assert_eq!(t.get(id).await.1, first);
    assert_eq!(t.send(&body).await.1, first);
    t.store()
        .await
        .delete(Table::Routines, t.routine["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(t.send(&body).await.1["status"], "missing");
    assert_eq!(t.cancel(id).await.1["status"], "missing");
    assert!(
        t.store()
            .await
            .list(Table::Routines)
            .await
            .unwrap()
            .is_empty()
    );
    t.f.close().await;
}
#[tokio::test]
async fn cancel_is_a_durable_fence_and_same_id_different_payload_or_stale_configuration_never_writes()
 {
    let mut t = Transfer::new().await;
    let body = t.body();
    let id = body["requestId"].as_str().unwrap();
    assert_eq!(t.cancel(id).await.1["status"], "not_transferred");
    assert_eq!(t.get(id).await.0, 410);
    let config = (*t.f.state.config).clone();
    t.f.state.close().await;
    t.f.state = State::open(config).await.unwrap();
    assert_eq!(t.send(&body).await.0, 410);
    assert_eq!(t.current().await, t.routine);
    let stale = t.body();
    let mut changed = t.routine.clone();
    changed["title"] = json!("Changed after preview");
    t.store()
        .await
        .put(Table::Routines, &changed)
        .await
        .unwrap();
    assert_eq!(t.send(&stale).await.0, 409);
    assert_eq!(t.current().await, changed);
    t.routine = changed;
    let accepted = t.body();
    assert_eq!(t.send(&accepted).await.0, 200);
    let mut different = accepted.clone();
    different["targetAgentId"] = json!("other-bot");
    assert_eq!(t.send(&different).await.0, 409);
    assert_eq!(
        t.store().await.list(Table::Routines).await.unwrap().len(),
        1
    );
    assert!(
        t.store()
            .await
            .list(Table::Messages)
            .await
            .unwrap()
            .is_empty()
    );
    t.f.close().await;
}
#[tokio::test]
async fn owner_identity_local_unique_dm_and_personal_scope_are_enforced_with_no_legacy_bypass() {
    let t = Transfer::new().await;
    let body = t.body();
    for (member, expected) in [
        (true, Some(t.f.member.as_str())),
        (false, Some(t.f.member.as_str())),
        (false, None),
    ] {
        assert_eq!(
            t.f.request("POST", &t.path(), Some(body.clone()), member, expected)
                .await
                .0,
            403
        );
    }
    let legacy =
        t.f.path(&format!("/routines/{}", t.routine["id"].as_str().unwrap()));
    let (status, error) =
        t.f.request(
            "PATCH",
            &legacy,
            Some(json!({"agentId":t.target["id"],"conversationId":t.chat["id"]})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(error["code"], "ROUTINE_TRANSFER_REQUIRED");
    let mut shared = t.target.clone();
    shared["sharedBot"] = json!({"status":"active"});
    t.store().await.put(Table::Agents, &shared).await.unwrap();
    assert_eq!(t.send(&body).await.0, 403);
    t.store().await.put(Table::Agents, &t.target).await.unwrap();
    let mut duplicate = t.chat.clone();
    duplicate["id"] = json!(uuid::Uuid::new_v4().to_string());
    t.store()
        .await
        .put(Table::Conversations, &duplicate)
        .await
        .unwrap();
    assert_eq!(t.send(&body).await.0, 409);
    t.store()
        .await
        .delete(Table::Conversations, duplicate["id"].as_str().unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET kind='team' WHERE id=?")
        .bind(&t.f.workspace)
        .execute(&t.f.db)
        .await
        .unwrap();
    assert_eq!(t.send(&body).await.0, 403);
    assert_eq!(t.current().await, t.routine);
    t.f.close().await;
}
#[tokio::test]
async fn group_owner_can_still_change_the_responsible_bot_inside_the_same_group() {
    let t = Transfer::new().await;
    let(status,group)=t.f.request("POST",&t.f.path("/conversations"),Some(json!({"title":"Shared work","agentIds":[t.routine["agentId"],t.target["id"]],"isGroup":true})),false,Some(&t.f.owner)).await;
    assert_eq!(status, 201, "{group}");
    let mut r = t.routine.clone();
    r["conversationId"] = group["id"].clone();
    t.store().await.put(Table::Routines, &r).await.unwrap();
    let (status, saved) =
        t.f.request(
            "PATCH",
            &t.f.path(&format!("/routines/{}", r["id"].as_str().unwrap())),
            Some(json!({"agentId":t.target["id"]})),
            false,
            Some(&t.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["conversationId"], group["id"]);
    assert_eq!(saved["nextRunAt"], r["nextRunAt"]);
    t.f.close().await;
}
