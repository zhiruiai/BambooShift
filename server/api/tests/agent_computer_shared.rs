mod agent_delegation_support;
mod computer_support;
mod shared_bots_support;
mod workspace_support;
use agent_delegation_support::{Model, call, finish, has_tool_result};
use computer_support::{Server, TOKEN};
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use shared_bots_support::{Shared, id};
use std::{sync::Arc, time::Duration};

async fn messages_until(store: &WorkspaceStore, check: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let messages = store.list(Table::Messages).await.unwrap();
            if check(&messages) {
                return messages;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Shared computer fixture did not settle")
}
async fn finished(s: &Shared) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !s.f.state.agent_runs.requests(&s.personal).await.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn shared_alias_controls_only_recipient_computer_and_revocation_stops_the_original_approval()
{
    let s = Shared::new().await;
    let joined = s.add().await;
    let alias = joined["agentId"].as_str().unwrap();
    let cid = joined["conversationId"].as_str().unwrap();
    let prefix = format!("/api/workspaces/{}", s.personal);
    let source_worker = Server::start(&s.f.workspace).await;
    let recipient_worker = Server::start(&s.personal).await;
    for (path, worker, member, actor) in [
        (
            s.f.path("/computer/connect"),
            &source_worker.worker,
            false,
            &s.f.owner,
        ),
        (
            format!("{prefix}/computer/connect"),
            &recipient_worker.worker,
            true,
            &s.f.member,
        ),
    ] {
        let (status, body) =
            s.f.request(
                "POST",
                &path,
                Some(json!({"mode":"remote","url":worker.origin,"token":TOKEN})),
                member,
                Some(actor),
            )
            .await;
        assert_eq!(status, 200, "{body}");
    }
    let model=Model::new(Arc::new(|body|Box::pin(async move {
        if has_tool_result(&body){finish("The shared Bot used its recipient's approved computer operation.")}
        else {call("computer_action",json!({"type":"write_file","path":"recipient-only.txt","content":"synthetic recipient data"}))}
    }))).await;
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
    let send = || json!({"clientId":id(),"agentId":alias,"content":"Use my personal computer through this shared Bot.","mode":"followUp"});
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
    let messages = messages_until(&target, |messages| {
        messages
            .iter()
            .any(|m| m["metadata"]["action"]["status"] == "pending")
    })
    .await;
    let action = &messages
        .iter()
        .find(|m| m["metadata"]["action"]["status"] == "pending")
        .unwrap()["metadata"]["action"];
    assert_eq!(action["agentId"], alias);
    assert_eq!(action["requester"]["messageId"], accepted["message"]["id"]);
    assert_eq!(action["requester"]["userId"], s.f.member);
    let approve = format!(
        "{prefix}/computer/bots/{alias}/actions/{}/approve",
        action["id"].as_str().unwrap()
    );
    assert_eq!(
        s.f.request("POST", &approve, Some(json!({})), false, Some(&s.f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        s.f.request("POST", &approve, Some(json!({})), true, Some(&s.f.member))
            .await
            .0,
        200
    );
    finished(&s).await;
    assert_eq!(
        recipient_worker
            .worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(path, _)| path.ends_with("/execute"))
            .count(),
        1
    );
    assert_eq!(
        source_worker
            .worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(path, _)| path.ends_with("/execute"))
            .count(),
        0
    );
    assert!(
        openbot_backend::computer::action_store::list(&s.source, None)
            .await
            .unwrap()
            .is_empty()
    );
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
    let messages = messages_until(&target, |messages| {
        messages
            .iter()
            .any(|m| m["metadata"]["action"]["status"] == "pending")
    })
    .await;
    let pending = messages
        .iter()
        .find(|m| m["metadata"]["action"]["status"] == "pending")
        .unwrap()["metadata"]["action"]
        .clone();
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
    finished(&s).await;
    let cancelled =
        openbot_backend::computer::action_store::get(&target, pending["id"].as_str().unwrap())
            .await
            .unwrap();
    assert_eq!(cancelled["status"], "rejected");
    assert_eq!(
        recipient_worker
            .worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(path, _)| path.ends_with("/execute"))
            .count(),
        1
    );
    assert_eq!(
        source_worker
            .worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(path, _)| path.starts_with("/screens/"))
            .count(),
        0
    );
    s.close().await;
}
