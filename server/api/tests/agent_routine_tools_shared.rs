mod agent_delegation_support;
mod shared_bots_support;
mod workspace_support;
use agent_delegation_support::{Model, call, finish, has_tool_result};
use openbot_backend::workspace::Table;
use serde_json::json;
use shared_bots_support::{Shared, id};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn drained(s: &Shared) {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while !s.f.state.agent_runs.requests(&s.personal).await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn shared_alias_creates_and_runs_only_recipient_plans_and_revocation_stops_the_next_run() {
    let s = Shared::new().await;
    let source_before = s.source.list(Table::Routines).await.unwrap();
    let joined = s.add().await;
    let alias = joined["agentId"].as_str().unwrap();
    let cid = joined["conversationId"].as_str().unwrap();
    let prefix = format!("/api/workspaces/{}", s.personal);
    let count = Arc::new(AtomicUsize::new(0));
    let step = count.clone();
    let model=Model::new(Arc::new(move|body|{let step=step.clone();Box::pin(async move{
        match step.fetch_add(1,Ordering::SeqCst){
            0=>call("routine_list",json!({})),
            1=>{let tool=body["messages"].as_array().unwrap().iter().rev().find(|m|m["role"]=="tool").unwrap();let value:serde_json::Value=serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();assert_eq!(value["total"],0);call("routine_create",json!({"title":"Recipient-owned plan","prompt":"Return one actual synthetic scheduled answer","schedule":"daily:09:30"}))},
            2=>{assert!(has_tool_result(&body));finish("The personal routine was saved without executing it.")},
            3=>finish("The actual personal routine ran with its existing source grant."),
            _=>panic!("A revoked source started another model request"),
        }
    })})).await;
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
    let posted=s.f.request("POST",&format!("{prefix}/conversations/{cid}/messages"),Some(json!({"content":"Create my local routine for this shared Bot, without executing it now.","clientId":id(),"agentId":alias,"mode":"followUp"})),true,Some(&s.f.member)).await;
    assert_eq!(posted.0, 202, "{}", posted.1);
    drained(&s).await;
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let routines = target.list(Table::Routines).await.unwrap();
    assert_eq!(routines.len(), 1);
    assert_eq!(routines[0]["agentId"], alias);
    assert_eq!(s.source.list(Table::Routines).await.unwrap(), source_before);
    assert_eq!(count.load(Ordering::SeqCst), 3);
    let run = format!(
        "{prefix}/routines/{}/run",
        routines[0]["id"].as_str().unwrap()
    );
    let started =
        s.f.request("POST", &run, Some(json!({})), true, Some(&s.f.member))
            .await;
    assert!([200, 202].contains(&started.0), "{}", started.1);
    drained(&s).await;
    assert_eq!(count.load(Ordering::SeqCst), 4);
    let revoked =
        s.f.request(
            "POST",
            &format!("{}/revoke", s.sharing()),
            Some(json!({"requestId":id(),"expectedRevision":s.share["revision"]})),
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(revoked.0, 200);
    let refused =
        s.f.request("POST", &run, Some(json!({})), true, Some(&s.f.member))
            .await;
    if [200, 202].contains(&refused.0) {
        drained(&s).await;
    } else {
        assert!([403, 409].contains(&refused.0), "{}", refused.1);
    }
    assert_eq!(count.load(Ordering::SeqCst), 4);
    assert_eq!(s.source.list(Table::Routines).await.unwrap(), source_before);
    drop(model);
    s.close().await;
}
