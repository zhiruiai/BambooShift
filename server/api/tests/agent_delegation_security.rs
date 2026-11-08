mod agent_delegation_support;
mod workspace_support;
use agent_delegation_support::*;
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Semaphore;

async fn cancelled_child(mode: &str) {
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (ready, gate) = (entered.clone(), release.clone());
    let model = Model::new(Arc::new(move |body| {
        let (target, ready, gate) = (target.clone(), ready.clone(), gate.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                ready.add_permits(1);
                gate.acquire().await.unwrap().forget();
                return call(
                    "remember",
                    json!({"content":"A cancelled child must never save this late preference"}),
                );
            }
            if !has_tool_result(&body) {
                call(
                    "delegate",
                    json!({"agentId":target,"task":"Wait for a controlled synthetic result."}),
                )
            } else {
                finish("The old child stopped; handle the current human instruction.")
            }
        })
    }))
    .await;
    g.configure(&model).await;
    g.send("Delegate then wait.", "followUp", false).await;
    wait_gate(&entered).await;
    match mode {
        "stop" => {
            let forbidden =
                g.f.request(
                    "POST",
                    &g.f.path(&format!("/conversations/{}/stop", g.cid)),
                    Some(json!({})),
                    true,
                    Some(&g.f.member),
                )
                .await;
            assert_eq!(forbidden.0, 403);
            g.stop().await;
        }
        "revoke" => {
            sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
                .bind(&g.f.owner)
                .execute(&g.f.db)
                .await
                .unwrap();
        }
        "steer" => {
            g.send(
                "Stop the old child and summarize the new instruction.",
                "steer",
                false,
            )
            .await;
        }
        _ => unreachable!(),
    }
    let messages = g.done().await;
    let child = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["agentId"] == g.ids[1])
        .unwrap();
    assert_eq!(child["status"], "error", "{messages:?}");
    assert!(g.store.list(Table::Memories).await.unwrap().is_empty());
    // A response released after all registered work drained cannot reach a live child worker.
    release.add_permits(1);
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert!(g.store.list(Table::Memories).await.unwrap().is_empty());
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
    assert!(
        g.store
            .list(Table::Agents)
            .await
            .unwrap()
            .iter()
            .all(|b| b["status"] == "idle")
    );
    drop(model);
    g.close().await;
}
#[tokio::test]
async fn only_original_human_can_stop_and_stop_drains_child_before_returning_idle() {
    cancelled_child("stop").await
}
#[tokio::test]
async fn original_session_revocation_stops_both_processes_and_refuses_late_child_memory() {
    cancelled_child("revoke").await
}
#[tokio::test]
async fn same_human_steer_fences_the_existing_child_without_borrowing_the_new_generation() {
    cancelled_child("steer").await
}

#[tokio::test]
async fn current_membership_and_root_snapshot_must_both_allow_a_target() {
    for addition in [true, false] {
        let g = Group::new().await;
        if addition {
            let change =
                g.f.request(
                    "PATCH",
                    &g.f.path(&format!("/conversations/{}", g.cid)),
                    Some(json!({"agentIds":g.ids[..3]})),
                    false,
                    Some(&g.f.owner),
                )
                .await;
            assert_eq!(change.0, 200);
        }
        let target = g.ids[if addition { 3 } else { 1 }].clone();
        let entered = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let (ready, gate) = (entered.clone(), release.clone());
        let model=Model::new(Arc::new(move|body|{let(target,ready,gate)=(target.clone(),ready.clone(),gate.clone());Box::pin(async move{
            assert_eq!(role(&body),0,"A disallowed child started");
            if has_tool_result(&body){return finish("The target was explicitly rejected.")}
            ready.add_permits(1);gate.acquire().await.unwrap().forget();
            call("delegate",json!({"agentId":target,"task":"This target must fail the membership intersection."}))
        })})).await;
        g.configure(&model).await;
        g.send(
            "Check the original workgroup membership.",
            "followUp",
            false,
        )
        .await;
        wait_gate(&entered).await;
        let ids = if addition {
            g.ids.clone()
        } else {
            vec![g.ids[0].clone(), g.ids[2].clone(), g.ids[3].clone()]
        };
        let change =
            g.f.request(
                "PATCH",
                &g.f.path(&format!("/conversations/{}", g.cid)),
                Some(json!({"agentIds":ids})),
                false,
                Some(&g.f.owner),
            )
            .await;
        assert_eq!(change.0, 200, "{}", change.1);
        release.add_permits(1);
        let messages = g.done().await;
        assert!(
            !messages
                .iter()
                .any(|m| m["metadata"]["delegation"].is_object())
        );
        assert_eq!(model.calls.lock().await.len(), 2);
        drop(model);
        g.close().await;
    }
}

#[tokio::test]
async fn a_late_first_model_response_cannot_borrow_a_new_human_steer_generation() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let count = Arc::new(AtomicUsize::new(0));
    let (ready, gate, roots) = (entered.clone(), release.clone(), count.clone());
    let model=Model::new(Arc::new(move|body|{let(target,ready,gate,roots)=(target.clone(),ready.clone(),gate.clone(),roots.clone());Box::pin(async move{
        if role(&body)==1{return finish("This obsolete child must not be started.")}
        if roots.fetch_add(1,Ordering::SeqCst)==0 {
            ready.add_permits(1);gate.acquire().await.unwrap().forget();
            call("delegate",json!({"agentId":target,"task":"Obsolete task from before the human changed requirements."}))
        } else {finish("Handled the new human request without starting the obsolete child.")}
    })})).await;
    g.configure(&model).await;
    g.send("First task that may delegate.", "followUp", false)
        .await;
    wait_gate(&entered).await;
    g.send(
        "Changed requirement: do not delegate; just summarize.",
        "steer",
        false,
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    release.add_permits(1);
    let messages = g.done().await;
    assert_eq!(
        model
            .calls
            .lock()
            .await
            .iter()
            .filter(|b| role(b) == 1)
            .count(),
        0,
        "An old model response borrowed the newer source input's permission"
    );
    assert!(
        !messages
            .iter()
            .any(|m| m["metadata"]["delegation"].is_object())
    );
    drop(model);
    g.close().await;
}
