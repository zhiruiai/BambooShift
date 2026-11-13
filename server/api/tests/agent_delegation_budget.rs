mod agent_delegation_support;
mod workspace_support;

use agent_delegation_support::*;
use axum::{body::Body, http::Response};
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn busy_preflight_refunds_admission_but_started_failures_still_count() {
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let busy_entered = Arc::new(Semaphore::new(0));
    let busy_release = Arc::new(Semaphore::new(0));
    let retries_finished = Arc::new(Semaphore::new(0));
    let retry_release = Arc::new(Semaphore::new(0));
    let root_calls = Arc::new(AtomicUsize::new(0));
    let child_calls = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new({
        let busy_entered = busy_entered.clone();
        let busy_release = busy_release.clone();
        let retries_finished = retries_finished.clone();
        let retry_release = retry_release.clone();
        let root_calls = root_calls.clone();
        let child_calls = child_calls.clone();
        move |body| {
            let target = target.clone();
            let busy_entered = busy_entered.clone();
            let busy_release = busy_release.clone();
            let retries_finished = retries_finished.clone();
            let retry_release = retry_release.clone();
            let root_calls = root_calls.clone();
            let child_calls = child_calls.clone();
            Box::pin(async move {
                if role(&body) == 1 {
                    match child_calls.fetch_add(1, Ordering::SeqCst) {
                        0 => {
                            busy_entered.add_permits(1);
                            wait_gate(&busy_release).await;
                            return finish("The independent synthetic task has finished.");
                        }
                        1 => {
                            return Response::builder()
                                .status(503)
                                .header("content-type", "application/json")
                                .body(Body::from(
                                    r#"{"error":{"message":"Synthetic child outage"}}"#,
                                ))
                                .unwrap();
                        }
                        _ => return finish("Synthetic accepted child result."),
                    }
                }
                assert_eq!(role(&body), 0);
                let request = root_calls.fetch_add(1, Ordering::SeqCst);
                if request == 8 {
                    retries_finished.add_permits(1);
                    wait_gate(&retry_release).await;
                }
                if request < 17 {
                    call(
                        "delegate",
                        json!({"agentId":target,"task":format!("Synthetic attempt {request}")}),
                    )
                } else {
                    finish("Reviewed the explicit child outcomes and the final budget limit.")
                }
            })
        }
    }))
    .await;
    g.configure(&model).await;
    let (status, chat) =
        g.f.request(
            "POST",
            &g.f.path("/conversations"),
            Some(
                json!({"title":"Synthetic independent task","agentIds":[g.ids[1]],"isGroup":false}),
            ),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(status, 201, "{chat}");
    let (status, response) = g.f.request(
        "POST", &g.f.path(&format!("/conversations/{}/messages", chat["id"].as_str().unwrap())),
        Some(json!({"content":"Hold the synthetic colleague busy.","agentId":g.ids[1],"clientId":uuid::Uuid::new_v4().to_string(),"mode":"followUp"})),
        false, Some(&g.f.owner),
    ).await;
    assert_eq!(status, 202, "{response}");
    wait_gate(&busy_entered).await;
    g.send(
        "Retry the busy colleague, then execute the bounded work.",
        "followUp",
        false,
    )
    .await;
    wait_gate(&retries_finished).await;
    busy_release.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while g
            .f
            .state
            .agent_runs
            .agent_busy(&g.f.workspace, &g.ids[1], None)
            .await
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The independent task should release the colleague");
    retry_release.add_permits(1);
    let messages = g.done().await;
    let calls = model.calls.lock().await;
    let final_root = calls.iter().rev().find(|body| role(body) == 0).unwrap();
    let results = final_root["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 17);
    assert!(
        results[..8]
            .iter()
            .all(|result| result.contains("这位同事正在执行其他任务"))
    );
    assert!(results[16].contains("最多委派八个子任务"));
    let children = messages
        .iter()
        .filter(|message| message["role"] == "assistant" && message["agentId"] == g.ids[1])
        .collect::<Vec<_>>();
    assert_eq!(
        children.len(),
        8,
        "Preflight failures must not spend child admissions"
    );
    assert_eq!(
        children
            .iter()
            .filter(|message| message["status"] == "error")
            .count(),
        1
    );
    assert_eq!(
        children
            .iter()
            .filter(|message| message["status"] == "done")
            .count(),
        7
    );
    assert_eq!(
        child_calls.load(Ordering::SeqCst),
        9,
        "One independent run and eight admitted children; no ninth child or automatic retry"
    );
    drop(calls);
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn failed_child_transaction_refunds_tracked_reservations_and_releases_the_target() {
    let g = Group::new().await;
    sqlx::query("CREATE TRIGGER reject_synthetic_child BEFORE UPDATE ON agents WHEN json_extract(NEW.data,'$.name')='Synthetic colleague 1' AND json_extract(NEW.data,'$.status')='working' BEGIN SELECT RAISE(ABORT,'synthetic child admission failure'); END")
        .execute(&g.store.pool).await.unwrap();
    let target = g.ids[1].clone();
    let rejected = Arc::new(Semaphore::new(0));
    let retry = Arc::new(Semaphore::new(0));
    let count = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new({
        let rejected = rejected.clone();
        let retry = retry.clone();
        move |body| {
            let target = target.clone();
            let rejected = rejected.clone();
            let retry = retry.clone();
            let count = count.clone();
            Box::pin(async move {
                if role(&body) == 1 {
                    return finish("Synthetic committed child result.");
                }
                let attempt = count.fetch_add(1, Ordering::SeqCst);
                if attempt == 8 {
                    rejected.add_permits(1);
                    wait_gate(&retry).await;
                }
                if attempt < 17 {
                    call("delegate", json!({"agentId":target,"task":"Return a synthetic result after admission."}))
                } else {
                    finish("The admitted child budget is exhausted.")
                }
            })
        }
    })).await;
    g.configure(&model).await;
    g.send(
        "Exercise synthetic transaction recovery.",
        "followUp",
        false,
    )
    .await;
    wait_gate(&rejected).await;
    assert!(
        !g.f.state
            .agent_runs
            .agent_busy(&g.f.workspace, &g.ids[1], None)
            .await
    );
    assert!(
        g.store
            .list(Table::Messages)
            .await
            .unwrap()
            .iter()
            .all(|message| !message["metadata"]["delegation"].is_object())
    );
    assert_eq!(
        g.store
            .get(Table::Agents, &g.ids[1])
            .await
            .unwrap()
            .unwrap()["status"],
        "idle"
    );
    sqlx::query("DROP TRIGGER reject_synthetic_child")
        .execute(&g.store.pool)
        .await
        .unwrap();
    retry.add_permits(1);
    let messages = g.done().await;
    let children = messages
        .iter()
        .filter(|message| message["role"] == "assistant" && message["agentId"] == g.ids[1])
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 8);
    assert!(children.iter().all(|message| message["status"] == "done"));
    let calls = model.calls.lock().await;
    assert_eq!(calls.iter().filter(|body| role(body) == 1).count(), 8);
    let final_root = calls.iter().rev().find(|body| role(body) == 0).unwrap();
    let final_result = final_root["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    assert!(
        final_result["content"]
            .as_str()
            .unwrap()
            .contains("最多委派八个子任务")
    );
    drop(calls);
    drop(model);
    g.close().await;
}
