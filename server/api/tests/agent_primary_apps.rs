mod agent_apps_support;
mod agent_delegation_support;
mod agent_primary_support;
mod apps_support;
mod workspace_support;
use agent_apps_support::{Model, call, finish};
use agent_primary_support::{dm, has_tool_result, personal, role};
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};

#[tokio::test]
async fn private_child_approval_keeps_original_requester_and_cannot_dispatch_after_parent_stop() {
    let (g, server, connection) = agent_apps_support::setup().await;
    let group = personal(g).await;
    let target = group.ids[1].clone();
    let connection = connection["id"].clone();
    let model=Model::new(Arc::new(move|body|{let(target,connection)=(target.clone(),connection.clone());Box::pin(async move{
        if has_tool_result(&body){finish("Use only the actual approved result.")}
        else if role(&body)==1 {call("app_call",json!({"connectionId":connection,"toolName":"write_note","arguments":{"text":"Synthetic child note"}}))}
        else {call("delegate",json!({"agentId":target,"task":"Ask for approval before writing one app note."}))}
    })})).await;
    group.configure(&model).await;
    let input = group.send("Delegate a note.", "followUp", false).await;
    let action = agent_apps_support::pending(&group.store).await;
    assert_eq!(action["requester"]["userId"], group.f.owner);
    assert_eq!(action["requester"]["messageId"], input["id"]);
    assert_eq!(action["conversationId"], dm(&group, 1).await["id"]);
    assert_eq!(
        agent_apps_support::decide(&group, &action, true).await.0,
        403
    );
    group.stop().await;
    group.done().await;
    assert_eq!(
        agent_apps_support::decide(&group, &action, false).await.0,
        409
    );
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    assert!(
        group
            .store
            .list(Table::Messages)
            .await
            .unwrap()
            .iter()
            .filter(|m| m["metadata"]["appAction"].is_object())
            .all(|m| m["metadata"]["appAction"]["status"] == "cancelled")
    );
    drop(model);
    drop(server);
    group.close().await;
}
