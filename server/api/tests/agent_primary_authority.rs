mod agent_delegation_support;
mod agent_primary_support;
mod workspace_support;
use agent_primary_support::*;
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Semaphore;

async fn interrupted(change: &str) {
    let group = personal(Group::new().await).await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (ready, gate, target) = (entered.clone(), release.clone(), group.ids[1].clone());
    let model = Model::new(Arc::new(move |body| {
        let (ready, gate, target) = (ready.clone(), gate.clone(), target.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                ready.add_permits(1);
                gate.acquire().await.unwrap().forget();
                return call(
                    "remember",
                    json!({"content":"Late cancelled private child write"}),
                );
            }
            if has_tool_result(&body) {
                finish("No late child result used.")
            } else {
                call(
                    "delegate",
                    json!({"agentId":target,"task":"Wait for a controlled synthetic response."}),
                )
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Start the controlled child.", "followUp", false)
        .await;
    wait_gate(&entered).await;
    match change {
        "stop" => group.stop().await,
        "logout" => {
            sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
                .bind(&group.f.owner)
                .execute(&group.f.db)
                .await
                .unwrap();
        }
        "role" => {
            sqlx::query("UPDATE memberships SET role='member' WHERE workspace_id=? AND user_id=?")
                .bind(&group.f.workspace)
                .bind(&group.f.owner)
                .execute(&group.f.db)
                .await
                .unwrap();
        }
        "target" => {
            let mut chat = dm(&group, 1).await;
            chat["isGroup"] = json!(true);
            chat["agentIds"] = json!([group.ids[1], group.ids[2]]);
            group.store.put(Table::Conversations, &chat).await.unwrap();
        }
        _ => panic!("Unknown fixture change"),
    }
    let parent = group.done().await;
    assert!(
        parent
            .iter()
            .any(|m| m["metadata"]["delegationProjection"] == true && m["status"] == "error")
    );
    assert!(group.store.list(Table::Memories).await.unwrap().is_empty());
    release.add_permits(1);
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert!(group.store.list(Table::Memories).await.unwrap().is_empty());
    assert!(
        group
            .store
            .list(Table::Agents)
            .await
            .unwrap()
            .iter()
            .all(|a| a["status"] == "idle")
    );
    assert_eq!(
        model
            .calls
            .lock()
            .await
            .iter()
            .filter(|b| role(b) == 1)
            .count(),
        1
    );
    drop(model);
    group.close().await;
}
#[tokio::test]
async fn stopping_parent_drains_real_private_child_before_idle_and_rejects_late_tool() {
    interrupted("stop").await;
}
#[tokio::test]
async fn original_login_revocation_stops_private_child_and_parent() {
    interrupted("logout").await;
}
#[tokio::test]
async fn removing_owner_role_invalidates_existing_private_delegation() {
    interrupted("role").await;
}
#[tokio::test]
async fn replacing_target_dm_membership_invalidates_its_frozen_destination() {
    interrupted("target").await;
}

#[tokio::test]
async fn nonprimary_member_shared_and_foreign_targets_cannot_start_private_children() {
    for mode in ["nonprimary", "member", "shared", "foreign"] {
        let mut group = personal(Group::new().await).await;
        if mode == "nonprimary" {
            group.cid = dm(&group, 1).await["id"].as_str().unwrap().to_owned();
            group.ids.swap(0, 1);
        }
        let target = if mode == "foreign" {
            uuid::Uuid::new_v4().to_string()
        } else {
            group.ids[1].clone()
        };
        if mode == "shared" {
            let mut bot = group
                .store
                .get(Table::Agents, &target)
                .await
                .unwrap()
                .unwrap();
            bot["sharedBot"] = json!({"shareId":uuid::Uuid::new_v4().to_string()});
            group.store.put(Table::Agents, &bot).await.unwrap();
        }
        let model = Model::new(Arc::new(move |body| {
            let target = target.clone();
            Box::pin(async move {
                if has_tool_result(&body) {
                    finish("Delegation was correctly rejected.")
                } else {
                    call(
                        "delegate",
                        json!({"agentId":target,"task":"This target must not run."}),
                    )
                }
            })
        }))
        .await;
        group.configure(&model).await;
        group
            .send("Attempt a forbidden target.", "followUp", mode == "member")
            .await;
        group.done().await;
        assert_eq!(model.calls.lock().await.len(), 2, "{mode}");
        assert!(
            !group
                .store
                .list(Table::Messages)
                .await
                .unwrap()
                .iter()
                .any(|m| m["metadata"]["delegation"].is_object()),
            "{mode}"
        );
        drop(model);
        group.close().await;
    }
}

#[tokio::test]
async fn switching_primary_keeps_the_accepted_child_but_refuses_a_new_private_delegation() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let group = personal(Group::new().await).await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let steps = Arc::new(AtomicUsize::new(0));
    let (ready, gate, first, second) = (
        entered.clone(),
        release.clone(),
        group.ids[1].clone(),
        group.ids[2].clone(),
    );
    let model = Model::new(Arc::new(move |body| {
        let (ready, gate, first, second, steps) = (
            ready.clone(),
            gate.clone(),
            first.clone(),
            second.clone(),
            steps.clone(),
        );
        Box::pin(async move {
            if role(&body) == 1 {
                ready.add_permits(1);
                gate.acquire().await.unwrap().forget();
                return finish("The already accepted child completed.");
            }
            match steps.fetch_add(1, Ordering::SeqCst) {
                0 => call(
                    "delegate",
                    json!({"agentId":first,"task":"Complete this accepted child."}),
                ),
                1 => call(
                    "delegate",
                    json!({"agentId":second,"task":"This new delegation must be denied."}),
                ),
                _ => finish("The old primary respected its changed role."),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Delegate a controlled task.", "followUp", false)
        .await;
    wait_gate(&entered).await;
    let selected = group
        .f
        .request(
            "GET",
            &group.f.path("/primary-bot"),
            None,
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(selected.0, 200);
    let changed = group.f.request("PUT", &group.f.path("/primary-bot"), Some(json!({"mode":"select","expectedRevision":selected.1["revision"],"agentId":group.ids[2],"checkIn":{"enabled":false,"time":"09:00"}})), false, Some(&group.f.owner)).await;
    assert_eq!(changed.0, 200, "{}", changed.1);
    release.add_permits(1);
    let messages = group.done().await;
    let cards = messages
        .iter()
        .filter(|m| m["metadata"]["delegationProjection"] == true)
        .collect::<Vec<_>>();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["status"], "done");
    assert!(messages.iter().any(
        |m| m["content"] == "The old primary respected its changed role." && m["status"] == "done"
    ));
    assert_eq!(model.calls.lock().await.len(), 4);
    assert!(!model.calls.lock().await.iter().any(|b| role(b) == 2));
    drop(model);
    group.close().await;
}
