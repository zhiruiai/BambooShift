mod team_builder_support;
mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use team_builder_support::*;
use workspace_support::Fixture;

#[tokio::test]
async fn real_pi_plans_without_tools_then_owner_commit_creates_once_and_reuses_live_bot() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let mut draft = proposal();
    draft["members"][0] = json!({"kind":"reuse","key":"a","agentId":boot["agents"][0]["id"],"assignment":"Lead synthetic review"});
    let (task, calls) = model(&f, draft, None).await;
    let request = json!({"requestId":uuid::Uuid::new_v4().to_string(),"goal":"Plan this synthetic review, do not execute it"});
    let (status, plan) = f
        .request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(request.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 202, "{plan}");
    let id = plan["id"].as_str().unwrap();
    let final_plan = ready(&f, id).await;
    assert_eq!(final_plan["status"], "ready", "{final_plan}");
    let snapshot = f.bootstrap().await;
    assert_eq!(snapshot["agents"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["conversations"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 0);
    let (status, repeated) = f
        .request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(request),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 202);
    assert_eq!(repeated, final_plan);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut bot = boot["agents"][0].clone();
    bot["status"] = json!("working");
    store.put(Table::Agents, &bot).await.unwrap();
    let input = commit(&final_plan);
    let path = f.path(&format!("/bot-team-plans/{id}/commit"));
    let (status, result) = f
        .request("POST", &path, Some(input.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["status"], "committed");
    let (status, repeat) = f
        .request("POST", &path, Some(input), false, Some(&f.owner))
        .await;
    assert_eq!(status, 200);
    assert_eq!(repeat, result);
    let snapshot = f.bootstrap().await;
    assert_eq!(snapshot["agents"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["conversations"].as_array().unwrap().len(), 3);
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 0);
    let chat = snapshot["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == result["result"]["conversationId"])
        .unwrap();
    assert_eq!(chat["agentIds"][0], bot["id"]);
    assert_eq!(chat["teamBrief"]["goal"], final_plan["goal"]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    task.abort();
    f.close().await;
}
#[tokio::test]
async fn owner_session_member_foreign_and_injected_fields_have_no_side_effects() {
    let f = Fixture::new().await;
    let request = json!({"requestId":uuid::Uuid::new_v4().to_string(),"goal":"Synthetic"});
    assert_eq!(
        f.request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(request.clone()),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(request.clone()),
            false,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    let foreign = format!("/api/workspaces/{}/bot-team-plans", f.foreign);
    assert_eq!(
        f.request(
            "POST",
            &foreign,
            Some(request.clone()),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        403
    );
    let mut injected = request.clone();
    injected["createdBy"] = json!(f.member);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(injected),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    let (status, plan) = f
        .request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(request),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 202);
    assert_eq!(
        ready(&f, plan["id"].as_str().unwrap()).await["status"],
        "error"
    );
    assert_eq!(f.bootstrap().await["agents"].as_array().unwrap().len(), 1);
    assert_eq!(
        f.request(
            "GET",
            &f.path("/bot-team-plans"),
            None,
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    f.close().await;
}
#[tokio::test]
async fn cancel_and_shutdown_stop_real_planner_without_publishing_late_model_output() {
    let f = Fixture::new().await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let (task, calls) = model(&f, proposal(), Some(gate.clone())).await;
    let (status, plan) = f
        .request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(
                json!({"requestId":uuid::Uuid::new_v4().to_string(),"goal":"Synthetic held plan"}),
            ),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 202);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while calls.load(Ordering::SeqCst) == 0 {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let id = plan["id"].as_str().unwrap();
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!("/bot-team-plans/{id}/cancel")),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    gate.notify_waiters();
    assert_eq!(ready(&f, id).await["status"], "cancelled");
    tokio::time::timeout(std::time::Duration::from_secs(5), f.state.close())
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    task.abort();
    f.db.close().await;
}

#[tokio::test]
async fn session_revocation_cancels_a_running_planner_and_never_saves_late_draft() {
    let f = Fixture::new().await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let (task, calls) = model(&f, proposal(), Some(gate.clone())).await;
    let request =
        json!({"requestId":uuid::Uuid::new_v4().to_string(),"goal":"Synthetic revoked request"});
    let (status, plan) = f
        .request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(request.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 202);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while calls.load(Ordering::SeqCst) == 0 {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let (status, replayed) = f
        .request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(request),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 202);
    assert_eq!(replayed, plan);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/bot-team-plans"),
            Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"goal":"Another"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    let ws = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    loop {
        let raw: String = sqlx::query_scalar("SELECT data FROM bot_team_plans WHERE id=?")
            .bind(plan["id"].as_str())
            .fetch_one(&ws.pool)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if value["plan"]["status"] != "generating" {
            assert_eq!(value["plan"]["status"], "cancelled");
            assert!(value["plan"].get("draft").is_none());
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    gate.notify_waiters();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(ws.list(Table::Agents).await.unwrap().len(), 1);
    assert_eq!(
        f.request(
            "GET",
            &f.path("/bot-team-plans"),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        401
    );
    task.abort();
    f.close().await;
}
#[tokio::test]
async fn model_output_cannot_select_avatar_assets_or_add_permission_fields() {
    let f = Fixture::new().await;
    let mut output = proposal();
    output["members"][0]["avatarImageId"] = json!(uuid::Uuid::new_v4().to_string());
    let (task, calls) = model(&f, output, None).await;
    let(status,plan)=f.request("POST",&f.path("/bot-team-plans"),Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"goal":"Synthetic model output validation"})),false,Some(&f.owner)).await;
    assert_eq!(status, 202);
    let result = ready(&f, plan["id"].as_str().unwrap()).await;
    assert_eq!(result["status"], "error");
    assert!(result.get("draft").is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.bootstrap().await["agents"].as_array().unwrap().len(), 1);
    task.abort();
    f.close().await;
}
