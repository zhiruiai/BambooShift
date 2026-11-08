mod agent_apps_support;
mod agent_delegation_support;
mod apps_support;
mod workspace_support;

use agent_apps_support::*;
use agent_delegation_support::{role, wait_gate};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::Semaphore;

async fn set_members(group: &Group, members: &[String]) {
    let response = group
        .f
        .request(
            "PATCH",
            &group.f.path(&format!("/conversations/{}", group.cid)),
            Some(json!({"agentIds":members})),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(response.0, 200, "{}", response.1);
    assert_eq!(response.1["agentIds"], json!(members));
}

#[tokio::test]
async fn removing_a_group_bot_invalidates_its_pending_mcp_approval_but_not_its_peer() {
    let (group, server, connection) = setup().await;
    set_members(&group, &group.ids[..2]).await;
    let connection_id = connection["id"].as_str().unwrap().to_owned();
    let model = Model::new(Arc::new(move |body| {
        let connection_id = connection_id.clone();
        Box::pin(async move {
            match role(&body) {
                0 => {
                    assert!(!agent_delegation_support::has_tool_result(&body));
                    call(
                        "app_call",
                        json!({"connectionId":connection_id,"toolName":"write_note",
                            "arguments":{"text":"Do not dispatch after group removal."}}),
                    )
                }
                1 => finish("The remaining colleague can still work."),
                other => panic!("Unexpected executing colleague: {other}"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let input = group
        .send("Request one application operation.", "followUp", true)
        .await;
    let action = pending(&group.store).await;
    assert_eq!(action["agentId"], group.ids[0]);
    assert_eq!(action["requester"]["userId"], group.f.member);
    assert_eq!(action["requester"]["messageId"], input["id"]);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);

    set_members(&group, &group.ids[1..2]).await;
    assert!(
        group
            .store
            .get(Table::Agents, &group.ids[0])
            .await
            .unwrap()
            .is_some()
    );
    let decision = decide(&group, &action, true).await;
    assert_eq!(decision.0, 409, "{}", decision.1);
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(model.calls.lock().await.len(), 1);
    let saved = openbot_backend::apps::actions::get(&group.store, action["id"].as_str().unwrap())
        .await
        .unwrap();
    assert!(openbot_backend::apps::actions::terminal(&saved));
    assert_ne!(saved["status"], "done");

    let next = group
        .f
        .request(
            "POST",
            &group
                .f
                .path(&format!("/conversations/{}/messages", group.cid)),
            Some(
                json!({"content":"Please continue with the remaining colleague.",
                "clientId":uuid::Uuid::new_v4().to_string(),
                "agentId":group.ids[1],"mode":"followUp"}),
            ),
            true,
            Some(&group.f.member),
        )
        .await;
    assert_eq!(next.0, 202, "{}", next.1);
    let messages = group.done().await;
    let reply = root_result(&messages, &next.1["message"]);
    assert_eq!(reply["agentId"], group.ids[1]);
    assert_eq!(reply["status"], "done");
    assert_eq!(reply["content"], "The remaining colleague can still work.");
    assert_eq!(model.calls.lock().await.len(), 2);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    drop(model);
    group.close().await;
}

#[tokio::test]
async fn a_late_model_file_write_cannot_outlive_the_executing_bots_group_membership() {
    let group = Group::new().await;
    set_members(&group, &group.ids[..2]).await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let returned = Arc::new(Semaphore::new(0));
    let model = {
        let (entered, release, returned) = (entered.clone(), release.clone(), returned.clone());
        Model::new(Arc::new(move |body| {
            let (entered, release, returned) = (entered.clone(), release.clone(), returned.clone());
            Box::pin(async move {
                assert_eq!(role(&body), 0);
                assert!(!agent_delegation_support::has_tool_result(&body));
                entered.add_permits(1);
                wait_gate(&release).await;
                let response = call(
                    "workspace_write",
                    json!({"path":"late-group-write.txt","content":"Unauthorized late content"}),
                );
                returned.add_permits(1);
                response
            })
        }))
        .await
    };
    group.configure(&model).await;
    let files_before: Vec<Value> = group.store.list(Table::Files).await.unwrap();
    let input = group
        .send("Prepare a synthetic local file.", "followUp", true)
        .await;
    wait_gate(&entered).await;
    set_members(&group, &group.ids[1..2]).await;
    release.add_permits(1);
    wait_gate(&returned).await;
    let messages = group.done().await;
    assert_eq!(root_result(&messages, &input)["status"], "error");
    assert_eq!(model.calls.lock().await.len(), 1);
    assert_eq!(group.store.list(Table::Files).await.unwrap(), files_before);
    assert!(
        !group
            .store
            .directory
            .join("workspace/late-group-write.txt")
            .exists()
    );
    assert!(
        group
            .store
            .get(Table::Agents, &group.ids[0])
            .await
            .unwrap()
            .is_some()
    );
    drop(model);
    group.close().await;
}
