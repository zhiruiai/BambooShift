mod agent_queue_support;
mod workspace_support;
use agent_queue_support::*;
use serde_json::{Value, json};

#[tokio::test]
async fn bound_steering_and_followups_share_a_run_while_another_member_gets_a_new_root() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let snapshot = f.bootstrap().await;
    let cid = snapshot["conversations"][0]["id"].as_str().unwrap();
    let root = submit(&f, cid, "Initial owner request", "followUp", false).await;
    model.wait().await;
    let steer = submit(&f, cid, "Owner steering", "steer", false).await;
    let follow = submit(&f, cid, "Owner follow-up", "followUp", false).await;
    let member = submit(&f, cid, "Independent member request", "steer", true).await;
    let before = f.bootstrap().await;
    for input in [&steer, &follow, &member] {
        let saved = before["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == input["id"])
            .unwrap();
        assert_eq!(saved["delivery"]["state"], "queued");
    }
    assert_eq!(before["runningRequests"][0]["requester"]["userId"], f.owner);
    model.release.add_permits(1);
    let final_state = wait(&f, |s| {
        s["runningRequests"] == json!([])
            && s["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "assistant" && m["status"] == "done")
                .count()
                >= 3
    })
    .await;
    let responses = final_state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "assistant" && m["status"] == "done")
        .map(|m| m["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        responses,
        vec![
            "Synthetic response 2",
            "Synthetic response 3",
            "Synthetic response 4"
        ],
        "{final_state}"
    );
    let by_id = |id: &Value| {
        final_state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| &m["id"] == id)
            .unwrap()
    };
    for input in [&root, &steer, &follow, &member] {
        assert_eq!(by_id(&input["id"])["delivery"]["state"], "delivered");
    }
    assert_eq!(
        by_id(&steer["id"])["delivery"]["runId"],
        root["delivery"]["runId"]
    );
    assert_eq!(
        by_id(&follow["id"])["delivery"]["runId"],
        root["delivery"]["runId"]
    );
    assert_ne!(
        by_id(&member["id"])["delivery"]["runId"],
        root["delivery"]["runId"]
    );
    let calls = model.calls.lock().await;
    assert_eq!(calls.len(), 4);
    assert!(calls[3].to_string().contains(&f.member));
    drop(calls);
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn stopping_a_root_cancels_only_its_owners_queue_and_continues_the_other_member() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let snapshot = f.bootstrap().await;
    let cid = snapshot["conversations"][0]["id"].as_str().unwrap();
    submit(&f, cid, "Held owner request", "followUp", false).await;
    model.wait().await;
    let queued = submit(&f, cid, "Cancel this owner follow-up", "followUp", false).await;
    let other = submit(&f, cid, "Keep this member request", "followUp", true).await;
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!("/conversations/{cid}/stop")),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    let state = wait(&f, |s| {
        s["runningRequests"] == json!([])
            && s["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["role"] == "assistant" && m["status"] == "done")
    })
    .await;
    let inputs = state["messages"].as_array().unwrap();
    assert_eq!(
        inputs.iter().find(|m| m["id"] == queued["id"]).unwrap()["delivery"]["state"],
        "cancelled"
    );
    assert_eq!(
        inputs.iter().find(|m| m["id"] == other["id"]).unwrap()["delivery"]["state"],
        "delivered"
    );
    assert_eq!(model.calls.lock().await.len(), 2);
    drop(model);
    f.close().await;
}
#[tokio::test]
async fn queued_input_keeps_its_original_session_authority() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let snapshot = f.bootstrap().await;
    let cid = snapshot["conversations"][0]["id"].as_str().unwrap();
    submit(&f, cid, "Held owner request", "followUp", false).await;
    model.wait().await;
    let queued = submit(&f, cid, "Revoked member request", "followUp", true).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    model.release.add_permits(1);
    let state = wait(&f, |s| {
        s["runningRequests"] == json!([])
            && s["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == queued["id"] && m["delivery"]["state"] == "interrupted")
    })
    .await;
    assert_eq!(model.calls.lock().await.len(), 1);
    assert_eq!(state["agents"][0]["status"], "idle");
    drop(model);
    f.close().await;
}
