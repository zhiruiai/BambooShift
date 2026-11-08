mod agent_apps_support;
mod agent_delegation_support;
mod apps_support;
mod shared_bots_support;
mod workspace_support;
use agent_apps_support::{
    Model, Server, call, connection_body, drained, finish, pending, tool_result,
};
use serde_json::{Value, json};
use shared_bots_support::{Shared, id};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn decision(s: &Shared, prefix: &str, action: &Value, member: bool) -> (u16, Value) {
    s.f.request(
        "POST",
        &format!(
            "{prefix}/app-actions/{}/decision",
            action["id"].as_str().unwrap()
        ),
        Some(json!({"approve":true})),
        member,
        Some(if member { &s.f.member } else { &s.f.owner }),
    )
    .await
}

#[tokio::test]
async fn explicit_shared_tools_keep_source_authority_separate_and_revocation_cancels_pending_call()
{
    let mut s = Shared::new().await;
    let source_remote = Server::start().await;
    let personal_remote = Server::start().await;
    for remote in [&source_remote.remote, &personal_remote.remote] {
        remote.bearer.store(true, Ordering::SeqCst);
    }
    s.f.state.apps = Arc::new(
        openbot_backend::apps::AppsRuntime::fixture(vec![
            source_remote.remote.origin.clone(),
            personal_remote.remote.origin.clone(),
        ])
        .unwrap(),
    );
    let prefix = format!("/api/workspaces/{}", s.personal);
    let (status, source) =
        s.f.request(
            "POST",
            &s.f.path("/apps"),
            Some(connection_body(&source_remote, "Publisher notes")),
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{source}");
    let source_id = source["id"].as_str().unwrap().to_owned();
    let (status, personal) =
        s.f.request(
            "POST",
            &format!("{prefix}/apps"),
            Some(connection_body(&personal_remote, "Recipient notes")),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(status, 200, "{personal}");
    let personal_id = personal["id"].as_str().unwrap().to_owned();
    let (status, catalog) =
        s.f.request(
            "GET",
            &format!("{}/apps/{source_id}", s.sharing()),
            None,
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{catalog}");
    s.update(json!({"apps":[{"connectionId":source_id,"connectionRevision":catalog["connectionRevision"],"tools":[{"name":"write_note","revision":catalog["tools"][0]["revision"]}]}]})).await;
    let joined = s.add().await;
    let alias = joined["agentId"].as_str().unwrap();
    let cid = joined["conversationId"].as_str().unwrap();
    let (expected_source, expected_personal) = (source_id.clone(), personal_id.clone());
    let steps = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |body| {
        let (source,personal,steps)=(expected_source.clone(),expected_personal.clone(),steps.clone());
        Box::pin(async move {
            match steps.fetch_add(1,Ordering::SeqCst) {
                0=>call("app_list",json!({})),
                1=>{
                    let result=tool_result(&body);
                    assert_eq!(result["apps"].as_array().unwrap().len(),1);
                    assert_eq!(result["apps"][0]["id"],personal);
                    assert!(!result.to_string().contains(&source));
                    call("shared_app_list",json!({}))
                }
                2=>{
                    let result=tool_result(&body);
                    assert_eq!(result["apps"].as_array().unwrap().len(),1);
                    assert_eq!(result["apps"][0]["connectionId"],source);
                    assert!(!result.to_string().contains(&personal));
                    call("app_tools",json!({"connectionId":personal,"toolName":"write_note"}))
                }
                3=>{
                    assert_eq!(tool_result(&body)["tools"][0]["name"],"write_note");
                    call("shared_app_tools",json!({"connectionId":source,"query":"synthetic","toolName":"write_note"}))
                }
                4=>{
                    assert_eq!(tool_result(&body)["tools"][0]["inputSchema"]["properties"]["text"]["type"],"string");
                    call("app_call",json!({"connectionId":personal,"toolName":"write_note","arguments":{"text":"personal-only operation"}}))
                }
                5=>{
                    let result=tool_result(&body);
                    assert_eq!(result["status"],"done");
                    assert!(result.get("source").is_none());
                    assert!(result["result"].to_string().contains("personal-only operation"));
                    call("shared_app_call",json!({"connectionId":source,"toolName":"write_note","arguments":{"text":"publisher-only operation"}}))
                }
                6=>{
                    let result=tool_result(&body);
                    assert_eq!(result["status"],"done");
                    assert_eq!(result["source"]["kind"],"shared_bot");
                    assert!(result["result"].to_string().contains("publisher-only operation"));
                    assert!(!result.to_string().contains("synthetic-access"));
                    finish("Both independently approved operations returned their actual results.")
                }
                7=>call("shared_app_call",json!({"connectionId":source,"toolName":"write_note","arguments":{"text":"must not run after publisher revokes"}})),
                _=>panic!("A revoked source unexpectedly continued the model"),
            }
        })
    })).await;
    assert_eq!(
        s.f.request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(model.config()),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        200
    );
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let send = || json!({"clientId":id(),"agentId":alias,"content":"Use my own app and the explicitly shared app separately.","mode":"followUp"});
    let (status, accepted) =
        s.f.request(
            "POST",
            &format!("{prefix}/conversations/{cid}/messages"),
            Some(send()),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(status, 202, "{accepted}");
    let local = pending(&target).await;
    assert_eq!(local["connectionId"], personal_id);
    assert!(local.get("source").is_none());
    assert_eq!(local["requester"]["userId"], s.f.member);
    assert_eq!(local["requester"]["messageId"], accepted["message"]["id"]);
    assert_eq!(decision(&s, &prefix, &local, false).await.0, 403);
    assert_eq!(source_remote.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(personal_remote.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(decision(&s, &prefix, &local, true).await.0, 200);
    let shared = pending(&target).await;
    assert_eq!(shared["connectionId"], source_id);
    assert_eq!(shared["source"]["kind"], "shared_bot");
    assert_eq!(shared["source"]["shareId"], s.share["id"]);
    assert_eq!(shared["requester"]["userId"], s.f.member);
    assert_eq!(shared["requester"]["messageId"], accepted["message"]["id"]);
    assert_eq!(
        shared["arguments"],
        json!({"text":"publisher-only operation"})
    );
    assert_eq!(personal_remote.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(source_remote.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(decision(&s, &prefix, &shared, false).await.0, 403);
    assert_eq!(decision(&s, &prefix, &shared, true).await.0, 200);
    drained(&s.f.state, &s.personal).await;
    assert_eq!(source_remote.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(personal_remote.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        openbot_backend::apps::connections::list(&target)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_actions")
            .fetch_one(&s.source.pool)
            .await
            .unwrap(),
        0
    );
    let result = openbot_backend::apps::actions::get(&target, shared["id"].as_str().unwrap())
        .await
        .unwrap();
    assert!(!result.to_string().contains(&source_remote.remote.origin));
    assert!(!result.to_string().contains("synthetic-access"));
    assert_eq!(
        s.f.request(
            "POST",
            &format!("{prefix}/conversations/{cid}/messages"),
            Some(send()),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        202
    );
    let waiting = pending(&target).await;
    assert_eq!(
        s.f.request(
            "POST",
            &format!("{}/revoke", s.sharing()),
            Some(json!({"requestId":id(),"expectedRevision":s.share["revision"]})),
            false,
            Some(&s.f.owner)
        )
        .await
        .0,
        200
    );
    drained(&s.f.state, &s.personal).await;
    let cancelled = openbot_backend::apps::actions::get(&target, waiting["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_ne!(decision(&s, &prefix, &waiting, true).await.0, 200);
    assert_eq!(source_remote.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(personal_remote.remote.calls.load(Ordering::SeqCst), 1);
    s.close().await;
}
