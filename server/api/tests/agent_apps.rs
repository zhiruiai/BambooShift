mod agent_apps_support;
mod agent_delegation_support;
mod apps_support;
mod workspace_support;
use agent_apps_support::*;
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn selected_app_has_a_separate_run_and_still_waits_for_requester_approval() {
    let (mut group, server, connection) = setup().await;
    let other_server = Server::start().await;
    other_server.remote.bearer.store(true, Ordering::SeqCst);
    group.f.state.apps = Arc::new(
        openbot_backend::apps::AppsRuntime::fixture(vec![
            server.remote.origin.clone(),
            other_server.remote.origin.clone(),
        ])
        .unwrap(),
    );
    let (status, other) = group
        .f
        .request(
            "POST",
            &group.f.path("/apps"),
            Some(connection_body(&other_server, "Other notes")),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200);
    let selected = connection["id"].clone();
    let revision = connection["revision"].clone();
    let start = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let sequence = Arc::new(AtomicUsize::new(0));
    let (model_start, model_release) = (start.clone(), release.clone());
    let (model_selected, model_other) = (selected.clone(), other["id"].clone());
    let model = Model::new(Arc::new(move |body| {
        let (start, release, sequence) = (model_start.clone(), model_release.clone(), sequence.clone());
        let (selected, other) = (model_selected.clone(), model_other.clone());
        Box::pin(async move {
            match sequence.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    start.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    assert!(!body["messages"].to_string().contains("selectedApp"));
                    finish("Original task finished.")
                }
                1 => {
                    let prompt = body["messages"].to_string();
                    assert!(prompt.contains("selectedApp") && prompt.contains(selected.as_str().unwrap()));
                    assert!(!prompt.contains("synthetic-access"));
                    call("list_apps", json!({}))
                }
                2 => {
                    let apps = tool_result(&body)["apps"].as_array().unwrap().clone();
                    assert_eq!(apps.len(), 1);
                    assert_eq!(apps[0]["id"], selected);
                    call("app_action", json!({"connectionId":other,"toolName":"write_note","arguments":{"text":"Wrong target"}}))
                }
                3 => {
                    assert!(body["messages"].to_string().contains("本次任务仅可使用用户选中的应用"));
                    call("app_action", json!({"connectionId":selected,"toolName":"write_note","arguments":{"text":"Selected note"}}))
                }
                _ => {
                    assert_eq!(tool_result(&body)["status"], "done");
                    finish("Confirmed note was written.")
                }
            }
        })
    })).await;
    group.configure(&model).await;
    let original = group
        .send("Complete an earlier task.", "followUp", true)
        .await;
    agent_delegation_support::wait_gate(&start).await;
    let path = group
        .f
        .path(&format!("/conversations/{}/messages", group.cid));
    let body = json!({"content":"Write this note.", "clientId":"app-context-request", "agentId":group.ids[0], "mode":"steer", "appContext":{"connectionId":selected,"revision":revision}});
    let (status, result) = group
        .f
        .request(
            "POST",
            &path,
            Some(body.clone()),
            true,
            Some(&group.f.member),
        )
        .await;
    assert_eq!(status, 202, "{result}");
    let message = &result["message"];
    assert_eq!(
        message["appContext"],
        json!({"connectionId":selected,"revision":revision,"name":"Personal notes"})
    );
    assert!(message["delivery"]["runId"].is_null());
    let (status, repeat) = group
        .f
        .request(
            "POST",
            &path,
            Some(body.clone()),
            true,
            Some(&group.f.member),
        )
        .await;
    assert_eq!(status, 202);
    assert_eq!(repeat["message"]["id"], message["id"]);
    let mut invalid = body.clone();
    invalid["appContext"]["revision"] = json!("old-revision");
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &path,
                Some(invalid.clone()),
                true,
                Some(&group.f.member)
            )
            .await
            .0,
        409
    );
    invalid["clientId"] = json!("stale-app-request");
    let (status, failure) = group
        .f
        .request("POST", &path, Some(invalid), true, Some(&group.f.member))
        .await;
    assert_eq!(status, 409);
    assert_eq!(failure["code"], "APP_CONTEXT_UNAVAILABLE");
    release.add_permits(1);
    let action = pending(&group.store).await;
    assert_eq!(action["requester"]["messageId"], message["id"]);
    assert_eq!(action["connectionId"], selected);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(other_server.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(decide(&group, &action, false).await.0, 403);
    assert_eq!(decide(&group, &action, true).await.0, 200);
    let messages = group.done().await;
    let delivered = messages
        .iter()
        .find(|item| item["id"] == message["id"])
        .unwrap();
    assert_ne!(
        delivered["delivery"]["runId"],
        original["delivery"]["runId"]
    );
    assert_eq!(root_result(&messages, &original)["status"], "done");
    assert_eq!(root_result(&messages, message)["status"], "done");
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(other_server.remote.calls.load(Ordering::SeqCst), 0);
    group.close().await;
}

#[tokio::test]
async fn an_app_disconnected_while_queued_does_not_cancel_an_independent_message() {
    let (group, server, app) = setup().await;
    let first_started = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let independent_started = Arc::new(Semaphore::new(0));
    let (start, proceed, next) = (
        first_started.clone(),
        release.clone(),
        independent_started.clone(),
    );
    let model = Model::new(Arc::new(move |body| {
        let (start, proceed, next) = (start.clone(), proceed.clone(), next.clone());
        Box::pin(async move {
            let prompt = body["messages"].to_string();
            assert!(!prompt.contains("selectedApp"));
            if prompt.contains("Independent request") {
                next.add_permits(1);
                finish("Independent result")
            } else {
                start.add_permits(1);
                proceed.acquire().await.unwrap().forget();
                finish("Original result")
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Earlier task remains active.", "followUp", true)
        .await;
    agent_delegation_support::wait_gate(&first_started).await;
    let path = group
        .f
        .path(&format!("/conversations/{}/messages", group.cid));
    let pinned = json!({"content":"Queued app work", "clientId":"queued-app", "agentId":group.ids[0], "appContext":{"connectionId":app["id"],"revision":app["revision"]}});
    let (status, pinned) = group
        .f
        .request("POST", &path, Some(pinned), true, Some(&group.f.member))
        .await;
    assert_eq!(status, 202, "{pinned}");
    let independent =
        json!({"content":"Independent request", "clientId":"independent", "agentId":group.ids[1]});
    let (status, independent) = group
        .f
        .request(
            "POST",
            &path,
            Some(independent),
            true,
            Some(&group.f.member),
        )
        .await;
    assert_eq!(status, 202, "{independent}");
    let disconnect = group
        .f
        .path(&format!("/apps/{}/disconnect", app["id"].as_str().unwrap()));
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &disconnect,
                Some(json!({})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        200
    );
    release.add_permits(1);
    agent_delegation_support::wait_gate(&independent_started).await;
    let messages = group.done().await;
    let failed = root_result(&messages, &pinned["message"]);
    assert_eq!(failed["status"], "error");
    assert!(
        failed["content"]
            .as_str()
            .unwrap()
            .contains("选中的应用已变更或断开")
    );
    assert_eq!(
        root_result(&messages, &independent["message"])["status"],
        "done"
    );
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    group.close().await;
}

#[tokio::test]
async fn original_app_tool_names_keep_real_requester_approval_and_result_in_thread() {
    let (group, server, connection) = setup().await;
    let cid = connection["id"].as_str().unwrap().to_owned();
    let expected = cid.clone();
    let steps = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |body| {
        let (expected, steps) = (expected.clone(), steps.clone());
        Box::pin(async move {
            match steps.fetch_add(1, Ordering::SeqCst) {
                0 => call("app_list", json!({})),
                1 => {
                    let result = tool_result(&body);
                    assert_eq!(result["apps"][0]["id"], expected);
                    assert!(!result.to_string().contains("synthetic-access"));
                    call("app_tools", json!({"connectionId":expected,"query":"synthetic","toolName":"write_note"}))
                }
                2 => {
                    let result = tool_result(&body);
                    assert_eq!(result["tools"][0]["name"], "write_note");
                    assert_eq!(result["tools"][0]["inputSchema"]["properties"]["text"]["type"], "string");
                    call("app_call", json!({"connectionId":expected,"toolName":"write_note","arguments":{"text":"exact personal request 🐷"}}))
                }
                3 => {
                    let result = tool_result(&body);
                    assert_eq!(result["status"], "done");
                    assert!(result["result"].to_string().contains("exact personal request 🐷"));
                    assert!(!result.to_string().contains("synthetic-access"));
                    finish("The approved real MCP note operation succeeded.")
                }
                _ => panic!("Unexpected model continuation"),
            }
        })
    })).await;
    group.configure(&model).await;
    let root = "app-approval-thread-root";
    group.store.put(Table::Messages, &json!({
        "id":root,"conversationId":group.cid,"role":"assistant","kind":"text","status":"done",
        "content":"Review the note workflow","createdAt":"2026-11-06T00:00:00Z"
    })).await.unwrap();
    let (status, receipt) = group
        .f
        .request(
            "POST",
            &group
                .f
                .path(&format!("/conversations/{}/messages", group.cid)),
            Some(
                json!({"content":"Read the app schema, then request this precise note.",
                "clientId":"app-approval-thread", "threadRootId":root, "agentId":group.ids[0]}),
            ),
            true,
            Some(&group.f.member),
        )
        .await;
    assert_eq!(status, 202, "{receipt}");
    let input = &receipt["message"];
    let action = pending(&group.store).await;
    let waiting = group.store.list(Table::Messages).await.unwrap();
    let card =
        |message: &&serde_json::Value| message["metadata"]["appAction"]["id"] == action["id"];
    assert_eq!(waiting.iter().find(card).unwrap()["threadRootId"], root);
    assert_eq!(action["requester"]["userId"], group.f.member);
    assert_eq!(action["requester"]["messageId"], input["id"]);
    assert_eq!(action["connectionId"], cid);
    assert_eq!(
        action["arguments"],
        json!({"text":"exact personal request 🐷"})
    );
    assert!(action.get("source").is_none());
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(decide(&group, &action, false).await.0, 403);
    assert_eq!(decide(&group, &action, true).await.0, 200);
    let messages = group.done().await;
    assert_eq!(root_result(&messages, input)["status"], "done");
    assert_eq!(root_result(&messages, input)["threadRootId"], root);
    assert_eq!(messages.iter().find(card).unwrap()["threadRootId"], root);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(decide(&group, &action, true).await.0, 409);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    group.close().await;
}

#[tokio::test]
async fn stop_during_real_mcp_call_cleans_process_and_does_not_claim_rollback_or_retry() {
    let (group, server, connection) = setup().await;
    let id = connection["id"].as_str().unwrap().to_owned();
    let model = Model::new(Arc::new(move |_| {
        let id = id.clone();
        Box::pin(async move {call("app_call",json!({"connectionId":id,"toolName":"write_note","arguments":{"text":"may already be applied"}}))})
    })).await;
    group.configure(&model).await;
    server.remote.hold.store(true, Ordering::SeqCst);
    let input = group
        .send("Start one app operation then wait.", "followUp", true)
        .await;
    let action = pending(&group.store).await;
    assert_eq!(decide(&group, &action, true).await.0, 200);
    apps_support::wait_until(|| server.remote.calls.load(Ordering::SeqCst) == 1).await;
    let path = group.f.path(&format!("/conversations/{}/stop", group.cid));
    assert_eq!(
        group
            .f
            .request("POST", &path, Some(json!({})), false, Some(&group.f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        group
            .f
            .request("POST", &path, Some(json!({})), true, Some(&group.f.member))
            .await
            .0,
        200
    );
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    let action = openbot_backend::apps::actions::get(&group.store, action["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(action["status"], "error");
    assert!(action["error"].as_str().unwrap().contains("结果未知"));
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    server.remote.hold.store(false, Ordering::SeqCst);
    group.close().await;
}
