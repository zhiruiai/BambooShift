mod agent_delegation_support;
mod knowledge_acceptance_support;
mod shared_bots_support;
mod workspace_support {
    pub use super::shared_bots_support::Fixture;
}

use agent_delegation_support::{Model, call, finish, role, wait_gate};
use knowledge_acceptance_support::{
    add_memory, latest_tool, result, seed_long_skills, system, tools,
};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use shared_bots_support::{Shared, id};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;

const READ_RESULT: &str = "The delegated shared Bot read the reviewed skill.";
const SOURCE_PRIVATE: &str = "SYNTHETIC_SOURCE_PRIVATE_MEMORY";
const ROOT_PRIVATE: &str = "SYNTHETIC_PARENT_PRIVATE_METHOD";

#[tokio::test]
async fn delegated_shared_knowledge_uses_the_source_grant_and_stops_after_revocation() {
    let shared = Shared::new().await;
    let mut source = shared
        .source
        .get(Table::Agents, &shared.agent)
        .await
        .unwrap()
        .unwrap();
    source["instructions"] = json!("SYNTHETIC_ROLE_1: Use only the shared approved skills.");
    source["configRevision"] = json!(id());
    shared.source.put(Table::Agents, &source).await.unwrap();
    let skills = seed_long_skills(&shared.f, &shared.agent).await;
    add_memory(&shared.f, &shared.agent, SOURCE_PRIVATE).await;
    let alias = shared.add().await["agentId"].as_str().unwrap().to_owned();
    let prefix = format!("/api/workspaces/{}", shared.personal);
    let (status, root) = shared
        .f
        .request(
            "POST",
            &format!("{prefix}/agents"),
            Some(json!({"name":"Synthetic personal coordinator","instructions":"SYNTHETIC_ROLE_0: Coordinate the shared Bot."})),
            true,
            Some(&shared.f.member),
        )
        .await;
    assert_eq!(status, 201, "{root}");
    let target_store = shared
        .f
        .state
        .workspace
        .get(&shared.personal, &shared.personal)
        .await
        .unwrap();
    target_store
        .put(
            Table::Skills,
            &json!({"id":id(),"agentId":root["id"],"name":"Synthetic parent-only method",
                "description":"Parent only","content":ROOT_PRIVATE,"status":"active","version":1}),
        )
        .await
        .unwrap();
    let (status, chat) = shared
        .f
        .request(
            "POST",
            &format!("{prefix}/conversations"),
            Some(json!({"title":"Synthetic collaboration","agentIds":[root["id"],alias],"isGroup":true})),
            true,
            Some(&shared.f.member),
        )
        .await;
    assert_eq!(status, 201, "{chat}");
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let child_count = Arc::new(AtomicUsize::new(0));
    let (ready, gate, count) = (entered.clone(), release.clone(), child_count.clone());
    let target = alias.clone();
    let skill = skills.last().unwrap().clone();
    let model = Model::new(Arc::new(move |body| {
        let (ready, gate, count) = (ready.clone(), gate.clone(), count.clone());
        let (target, skill) = (target.clone(), skill.clone());
        Box::pin(async move {
            let prompt = system(&body);
            assert!(!prompt.contains(SOURCE_PRIVATE));
            let responses = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["role"] == "tool")
                .count();
            match (role(&body), responses) {
                (0, 0) => {
                    assert!(prompt.contains(ROOT_PRIVATE));
                    assert!(!tools(&body).contains(&"list_skills"));
                    call(
                        "delegate",
                        json!({"agentId":target,"task":"Read the approved source workflow."}),
                    )
                }
                (0, 1) => {
                    assert!(latest_tool(&body).unwrap().contains(READ_RESULT));
                    call(
                        "delegate",
                        json!({"agentId":target,"task":"Read the same source workflow again."}),
                    )
                }
                (1, 0) => {
                    assert!(!prompt.contains(ROOT_PRIVATE));
                    assert!(!prompt.contains("SYNTHETIC_METHOD_TAIL_07"));
                    assert!(tools(&body).contains(&"read_skill"));
                    if count.fetch_add(1, Ordering::SeqCst) == 0 {
                        return call("list_skills", json!({"query":"method 07"}));
                    }
                    ready.add_permits(1);
                    wait_gate(&gate).await;
                    call("read_skill", json!({"skillId":skill["id"]}))
                }
                (1, 1) if count.load(Ordering::SeqCst) == 1 => {
                    let catalog = result(latest_tool(&body).unwrap());
                    assert_eq!(catalog["total"], 8);
                    assert_eq!(catalog["matched"], 1);
                    assert_eq!(catalog["skills"][0]["id"], skill["id"]);
                    call("read_skill", json!({"skillId":skill["id"]}))
                }
                (1, 2) => {
                    let read = result(latest_tool(&body).unwrap());
                    assert_eq!(read["id"], skill["id"]);
                    assert!(read["content"].as_str() == skill["content"].as_str());
                    finish(READ_RESULT)
                }
                _ => panic!("The revoked source should not yield another knowledge result"),
            }
        })
    }))
    .await;
    let (status, settings) = shared
        .f
        .request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(model.config()),
            true,
            Some(&shared.f.member),
        )
        .await;
    assert_eq!(status, 200, "{settings}");
    let (status, receipt) = shared
        .f
        .request(
            "POST",
            &format!(
                "{prefix}/conversations/{}/messages",
                chat["id"].as_str().unwrap()
            ),
            Some(
                json!({"clientId":id(),"agentId":root["id"],"mode":"followUp",
                "content":"Use the shared synthetic workflow twice."}),
            ),
            true,
            Some(&shared.f.member),
        )
        .await;
    assert_eq!(status, 202, "{receipt}");
    wait_gate(&entered).await;
    let completed = target_store.list(Table::Messages).await.unwrap();
    assert!(
        completed
            .iter()
            .any(|row| row["agentId"] == alias && row["content"] == READ_RESULT)
    );
    let (status, receipt) = shared
        .f
        .request(
            "POST",
            &format!("{}/revoke", shared.sharing()),
            Some(json!({"requestId":id(),"expectedRevision":shared.share["revision"]})),
            false,
            Some(&shared.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{receipt}");
    release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(25), async {
        while !shared
            .f
            .state
            .agent_runs
            .requests(&shared.personal)
            .await
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Revoking the source should drain its actual Pi runs");
    let transcript = target_store.list(Table::Messages).await.unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|row| row["content"] == READ_RESULT)
            .count(),
        1
    );
    assert!(
        transcript
            .iter()
            .any(|row| row["agentId"] == root["id"] && row["status"] == "error")
    );
    let calls = model.calls.lock().await;
    assert_eq!(child_count.load(Ordering::SeqCst), 2);
    assert_eq!(calls.len(), 6);
    assert!(
        !calls
            .iter()
            .any(|body: &Value| body.to_string().contains(SOURCE_PRIVATE))
    );
    drop(calls);
    drop(model);
    shared.close().await;
}
