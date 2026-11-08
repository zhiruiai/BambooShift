mod apps_support;
mod workspace_support;
use apps_support::*;
use openbot_backend::{
    apps::{self, Authority, actions, connections},
    error::ApiError,
    workspace::access,
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use workspace_support::Fixture;

#[tokio::test]
async fn source_service_is_pinned_while_approval_and_chat_belong_to_recipient() {
    let server = Server::start().await;
    server.remote.bearer.store(true, Ordering::SeqCst);
    let mut f = Fixture::new().await;
    f.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    let owner = access::require(
        &f.state,
        &headers(&f.owner_token, &f.owner),
        &f.workspace,
        true,
        true,
    )
    .await
    .unwrap();
    let source = owner.store(&f.state).await.unwrap();
    let connection=connections::add(&f.state,&source,&json!({"name":"Source notes","url":format!("{}/mcp",server.remote.origin),"authType":"bearer","token":"synthetic-access","shared":true}),apps::user_authority(&f.state,&owner)).await.unwrap();
    let recipient = access::require(
        &f.state,
        &headers(&f.member_token, &f.member),
        &f.foreign,
        false,
        true,
    )
    .await
    .unwrap();
    let target = recipient.store(&f.state).await.unwrap();
    let chat = target
        .list(openbot_backend::workspace::Table::Conversations)
        .await
        .unwrap()
        .remove(0);
    let allowed = Arc::new(AtomicBool::new(true));
    let human = apps::user_authority(&f.state, &recipient);
    let authority: Authority = {
        let allowed = allowed.clone();
        Arc::new(move || {
            let allowed = allowed.clone();
            let human = human.clone();
            Box::pin(async move {
                human().await?;
                if allowed.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(ApiError::new(403, "共享来源授权已撤销。"))
                }
            })
        })
    };
    let prepared = connections::prepare_call(
        &source,
        connection["id"].as_str().unwrap(),
        "write_note",
        &json!({"text":"recipient request"}),
    )
    .await
    .unwrap();
    let context = actions::ActionContext {
        conversation_id: chat["id"].as_str().unwrap().into(),
        thread_root_id: None,
        agent_id: chat["agentIds"][0].as_str().unwrap().into(),
        run_id: "shared-fixture".into(),
        requester: Some(json!({"userId":f.member})),
        source: Some(
            json!({"kind":"shared_bot","shareId":uuid::Uuid::new_v4().to_string(),"botName":"Shared Bot","ownerName":"Publisher"}),
        ),
    };
    let action = actions::request(
        &f.state,
        target.clone(),
        source.clone(),
        context.clone(),
        prepared.clone(),
        authority.clone(),
    )
    .await
    .unwrap();
    let result = actions::decide(
        &f.state,
        &target,
        action["id"].as_str().unwrap(),
        true,
        &recipient,
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "running");
    let done = actions::wait(
        &f.state,
        &target,
        action["id"].as_str().unwrap(),
        authority.clone(),
    )
    .await
    .unwrap();
    assert_eq!(done["status"], "done");
    assert_eq!(done["source"]["ownerName"], "Publisher");
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    assert!(!target.directory.join("config/apps.private.json").exists());
    assert!(connections::list(&target).await.unwrap().is_empty());
    assert!(!done.to_string().contains("synthetic-access"));
    assert!(!done.to_string().contains(&server.remote.origin));
    let pending = actions::request(
        &f.state,
        target.clone(),
        source,
        context,
        prepared,
        authority.clone(),
    )
    .await
    .unwrap();
    allowed.store(false, Ordering::SeqCst);
    assert!(
        actions::decide(
            &f.state,
            &target,
            pending["id"].as_str().unwrap(),
            true,
            &recipient
        )
        .await
        .is_err()
    );
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    f.close().await;
}
#[tokio::test]
async fn shutdown_cancels_pending_and_waits_for_inflight_protocol_worker() {
    let server = Server::start().await;
    let mut f = Fixture::new().await;
    f.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    let actor = access::require(
        &f.state,
        &headers(&f.owner_token, &f.owner),
        &f.workspace,
        true,
        true,
    )
    .await
    .unwrap();
    let store = actor.store(&f.state).await.unwrap();
    let c=connections::add(&f.state,&store,&json!({"name":"Close","url":format!("{}/mcp",server.remote.origin),"authType":"none","shared":true}),apps::user_authority(&f.state,&actor)).await.unwrap();
    let prepared =
        connections::prepare_call(&store, c["id"].as_str().unwrap(), "write_note", &json!({}))
            .await
            .unwrap();
    let chat = store
        .list(openbot_backend::workspace::Table::Conversations)
        .await
        .unwrap()
        .remove(0);
    let context = actions::ActionContext {
        conversation_id: chat["id"].as_str().unwrap().into(),
        thread_root_id: None,
        agent_id: chat["agentIds"][0].as_str().unwrap().into(),
        run_id: "shutdown-fixture".into(),
        requester: None,
        source: None,
    };
    let authority = apps::user_authority(&f.state, &actor);
    let pending = actions::request(
        &f.state,
        store.clone(),
        store.clone(),
        context.clone(),
        prepared.clone(),
        authority.clone(),
    )
    .await
    .unwrap();
    let running = actions::request(
        &f.state,
        store.clone(),
        store.clone(),
        context,
        prepared,
        authority,
    )
    .await
    .unwrap();
    server.remote.hold.store(true, Ordering::SeqCst);
    actions::decide(
        &f.state,
        &store,
        running["id"].as_str().unwrap(),
        true,
        &actor,
    )
    .await
    .unwrap();
    wait_until(|| server.remote.calls.load(Ordering::SeqCst) == 1).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        f.state.apps.close(&f.state),
    )
    .await
    .unwrap();
    assert_eq!(
        actions::get(&store, pending["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "cancelled"
    );
    assert_eq!(
        actions::get(&store, running["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "error"
    );
    server.remote.hold.store(false, Ordering::SeqCst);
    f.close().await;
}
