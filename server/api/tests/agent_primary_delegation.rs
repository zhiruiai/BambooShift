mod agent_delegation_support;
mod agent_primary_support;
mod workspace_support;
use agent_primary_support::*;
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn current_identity_is_explicit_and_saved_profile_changes_apply_to_the_next_human_run() {
    let group = personal(Group::new().await).await;
    update(&group, 0, json!({"name":"Personal coordinator","role":"Own synthetic planning","description":"Keep these duties separate from colleagues."})).await;
    let model = Model::new(Arc::new(|_| {
        Box::pin(async { finish("Identity captured.") })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Identify your current role.", "followUp", false)
        .await;
    group.done().await;
    update(
        &group,
        0,
        json!({"role":"Own revised synthetic planning","description":"Updated next-run duties."}),
    )
    .await;
    group
        .send("Use the latest saved role.", "followUp", false)
        .await;
    group.done().await;
    let calls = model.calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(identity(&calls[0])["id"], group.ids[0]);
    assert_eq!(identity(&calls[0])["name"], "Personal coordinator");
    assert_eq!(identity(&calls[0])["role"], "Own synthetic planning");
    assert_eq!(
        identity(&calls[1])["role"],
        "Own revised synthetic planning"
    );
    assert_eq!(
        identity(&calls[1])["description"],
        "Updated next-run duties."
    );
    assert!(system(&calls[0]).contains("selected personal primary Bot"));
    assert!(system(&calls[0]).contains("not any colleague"));
    assert_ne!(
        identity(&calls[0])["configRevision"],
        identity(&calls[1])["configRevision"]
    );
    drop(calls);
    drop(model);
    group.close().await;
}

#[tokio::test]
async fn primary_dm_delegates_in_the_target_dm_and_only_returns_the_actual_result_to_parent() {
    let group = personal(Group::new().await).await;
    let chat = dm(&group, 1).await;
    group.store.put(Table::Messages, &json!({"id":"private-child-history","conversationId":chat["id"],"agentId":group.ids[1],"role":"assistant","kind":"text","status":"done","content":"CHILD_HISTORY_NOT_PARENT_HISTORY","createdAt":"2026-01-01T00:00:00Z"})).await.unwrap();
    let target = group.ids[1].clone();
    let own = group.ids[0].clone();
    let model = Model::new(Arc::new(move |body| {
        let (target,own)=(target.clone(),own.clone());
        Box::pin(async move {
            if role(&body)==1 {
                assert_eq!(identity(&body)["id"], target);
                assert!(body.to_string().contains("CHILD_HISTORY_NOT_PARENT_HISTORY"));
                assert!(!system(&body).contains("selected personal primary Bot"));
                if !has_tool_result(&body) { call("remember",json!({"content":"Child owns its actual preference"})) }
                else { finish("Verified target result.") }
            } else {
                assert_eq!(identity(&body)["id"], own);
                assert!(!body.to_string().contains("CHILD_HISTORY_NOT_PARENT_HISTORY"));
                if !has_tool_result(&body) { call("delegate",json!({"agentId":target,"task":"Save a child preference, then give the result."})) }
                else { assert!(body.to_string().contains("Verified target result.")); finish("Parent used actual target result.") }
            }
        })
    })).await;
    group.configure(&model).await;
    let input = group
        .send("Coordinate with the local colleague.", "followUp", false)
        .await;
    let parent = group.done().await;
    let card = parent
        .iter()
        .find(|m| m["metadata"]["delegationProjection"] == true)
        .unwrap();
    assert_eq!(card["status"], "done");
    assert_eq!(card["content"], "Verified target result.");
    assert_eq!(card["metadata"]["resultConversationId"], chat["id"]);
    let messages = group.store.list(Table::Messages).await.unwrap();
    let child = messages
        .iter()
        .find(|m| m["id"] == card["metadata"]["resultMessageId"])
        .unwrap();
    assert_eq!(child["conversationId"], chat["id"]);
    assert_eq!(
        child["metadata"]["delegation"]["requesterMessageId"],
        input["id"]
    );
    assert_eq!(
        group.store.list(Table::Memories).await.unwrap()[0]["agentId"],
        group.ids[1]
    );
    assert_eq!(model.calls.lock().await.len(), 4);
    drop(model);
    group.close().await;
}

#[tokio::test]
async fn repeated_child_keeps_its_root_profile_snapshot_then_new_root_gets_new_configuration() {
    let group = personal(Group::new().await).await;
    update(&group, 1, json!({"role":"Original child duty"})).await;
    let gate = Arc::new(Semaphore::new(0));
    let entered = Arc::new(Semaphore::new(0));
    let count = Arc::new(AtomicUsize::new(0));
    let target = group.ids[1].clone();
    let (wait, ready, steps) = (gate.clone(), entered.clone(), count.clone());
    let model = Model::new(Arc::new(move |body| {
        let (target, wait, ready, steps) =
            (target.clone(), wait.clone(), ready.clone(), steps.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                return finish("Child snapshot result.");
            }
            let step = steps.fetch_add(1, Ordering::SeqCst);
            if step == 1 {
                ready.add_permits(1);
                wait.acquire().await.unwrap().forget();
            }
            if step < 2 {
                call(
                    "delegate",
                    json!({"agentId":target,"task":"Use this root's fixed profile."}),
                )
            } else {
                finish("Both results received.")
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Ask the colleague twice.", "followUp", false)
        .await;
    wait_gate(&entered).await;
    update(&group, 1, json!({"role":"Changed next-root duty"})).await;
    gate.add_permits(1);
    group.done().await;
    let calls = model.calls.lock().await;
    let children = calls.iter().filter(|b| role(b) == 1).collect::<Vec<_>>();
    assert_eq!(children.len(), 2);
    for child in children {
        assert_eq!(identity(child)["role"], "Original child duty");
    }
    drop(calls);
    drop(model);
    let next = Model::new(Arc::new(|body| {
        Box::pin(async move {
            assert_eq!(identity(&body)["role"], "Changed next-root duty");
            finish("New configuration used.")
        })
    }))
    .await;
    group.configure(&next).await;
    let target_chat = dm(&group, 1).await;
    let reply=group.f.request("POST",&group.f.path(&format!("/conversations/{}/messages",target_chat["id"].as_str().unwrap())),Some(json!({"content":"Use your new profile.","clientId":"next-root","agentId":group.ids[1]})),false,Some(&group.f.owner)).await;
    assert_eq!(reply.0, 202);
    group.done().await;
    drop(next);
    group.close().await;
}

#[tokio::test]
async fn human_message_in_target_dm_waits_for_the_actual_child_to_finish() {
    let group = personal(Group::new().await).await;
    let target_chat = dm(&group, 1).await;
    let gate = Arc::new(Semaphore::new(0));
    let entered = Arc::new(Semaphore::new(0));
    let children = Arc::new(AtomicUsize::new(0));
    let target = group.ids[1].clone();
    let (wait, ready, count) = (gate.clone(), entered.clone(), children.clone());
    let model = Model::new(Arc::new(move |body| {
        let (target, wait, ready, count) =
            (target.clone(), wait.clone(), ready.clone(), count.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    ready.add_permits(1);
                    wait.acquire().await.unwrap().forget();
                    finish("Delegated child finished before the human follow-up.")
                } else {
                    finish("Queued human message answered in its own root.")
                }
            } else if !has_tool_result(&body) {
                call(
                    "delegate",
                    json!({"agentId":target,"task":"Finish the delegated task first."}),
                )
            } else {
                finish("Child result received.")
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Delegate to the colleague.", "followUp", false)
        .await;
    wait_gate(&entered).await;
    let response=group.f.request("POST",&group.f.path(&format!("/conversations/{}/messages",target_chat["id"].as_str().unwrap())),Some(json!({"content":"Then answer this separate human request.","clientId":"queued-in-target","agentId":group.ids[1],"mode":"steer"})),false,Some(&group.f.owner)).await;
    assert_eq!(response.0, 202, "{}", response.1);
    let message_id = response.1["message"]["id"].as_str().unwrap();
    assert_eq!(
        group
            .store
            .get(Table::Messages, message_id)
            .await
            .unwrap()
            .unwrap()["delivery"]["state"],
        "queued"
    );
    assert_eq!(children.load(Ordering::SeqCst), 1);
    gate.add_permits(1);
    group.done().await;
    let messages = group.store.list(Table::Messages).await.unwrap();
    let reply = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["metadata"]["inputMessageId"] == message_id)
        .unwrap();
    assert_eq!(reply["conversationId"], target_chat["id"]);
    assert_eq!(reply["status"], "done");
    assert_eq!(
        reply["content"],
        "Queued human message answered in its own root."
    );
    assert!(reply["metadata"]["delegation"].is_null());
    assert_eq!(children.load(Ordering::SeqCst), 2);
    drop(model);
    group.close().await;
}
