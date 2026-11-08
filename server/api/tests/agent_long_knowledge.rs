mod agent_delegation_support;
mod knowledge_acceptance_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, wait_gate};
use knowledge_acceptance_support::{
    add_memory, approve, latest_tool, propose, recall, result, seed_long_skills, system, tools,
};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, Semaphore};

const FINISHED: &str = "Synthetic long knowledge was read in full.";
const NEW_MEMORY: &str = "SYNTHETIC_SAME_RUN_MEMORY";

#[tokio::test]
async fn real_pi_reads_all_paged_memories_and_the_captured_approved_skill() {
    let group = Group::new().await;
    let skills = seed_long_skills(&group.f, &group.ids[0]).await;
    let old_tail = skills.last().unwrap().clone();
    let next_tail = propose(
        &group.f,
        &group.ids[0],
        old_tail["name"].as_str().unwrap(),
        "NEW_VERSION_CANARY_FOR_LATER_RUNS",
    )
    .await;
    let foreign_draft = propose(
        &group.f,
        &group.ids[1],
        "Other colleague skill",
        "OTHER_COLLEAGUE_PRIVATE_SKILL",
    )
    .await;
    let foreign = approve(&group.f, &foreign_draft, None).await;
    add_memory(&group.f, &group.ids[1], "Scoped other colleague memory").await;

    let mut expected_memories = BTreeMap::new();
    for index in 0..105 {
        let body = format!(
            "Scoped memory {index:03} {} MEMORY_TAIL_{index:03}",
            "记🚀".repeat(85)
        );
        let record = add_memory(&group.f, &group.ids[0], &body).await;
        expected_memories.insert(record["id"].as_str().unwrap().to_owned(), body);
    }
    let expected_ids = skills
        .iter()
        .map(|record| record["id"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    let reached = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let memory_seen = Arc::new(Mutex::new(BTreeSet::new()));
    let (ready, gate, seen) = (reached.clone(), release.clone(), memory_seen.clone());
    let actor = group.ids[0].clone();
    let blocked = [foreign["id"].clone(), next_tail["id"].clone()];
    let stage = Arc::new(AtomicUsize::new(0));
    let progress = stage.clone();
    let expected_memories = Arc::new(expected_memories);
    let expected_ids = Arc::new(expected_ids);
    let model = Model::new(Arc::new(move |body| {
        let (ready, gate, seen, stage) =
            (ready.clone(), gate.clone(), seen.clone(), progress.clone());
        let (actor, blocked, skill) = (actor.clone(), blocked.clone(), old_tail.clone());
        let (expected_memories, expected_ids) = (expected_memories.clone(), expected_ids.clone());
        Box::pin(async move {
            let step = stage.fetch_add(1, Ordering::SeqCst);
            let content = system(&body);
            assert!(content.encode_utf16().count() < 128_000);
            for hidden in [
                "SYNTHETIC_METHOD_TAIL_07",
                "MEMORY_TAIL_104",
                "NEW_VERSION_CANARY_FOR_LATER_RUNS",
                "OTHER_COLLEAGUE_PRIVATE_SKILL",
                "Scoped other colleague memory",
            ] {
                assert!(!content.contains(hidden));
            }
            match step {
                0 => {
                    for tool in ["list_skills", "read_skill", "recall"] {
                        assert!(tools(&body).contains(&tool), "{tool} was not offered");
                        assert!(content.contains(tool));
                    }
                    assert!(content.contains("Synthetic method 07"));
                    ready.add_permits(1);
                    wait_gate(&gate).await;
                    call("list_skills", json!({}))
                }
                1 => {
                    let catalog = result(latest_tool(&body).unwrap());
                    assert_eq!(catalog["total"], 8);
                    assert_eq!(catalog["matched"], 8);
                    assert!(catalog["nextCursor"].is_null());
                    let entries = catalog["skills"].as_array().unwrap();
                    let ids = entries
                        .iter()
                        .map(|row| {
                            assert_eq!(row["version"], 1);
                            assert_eq!(row["description"], "Synthetic workflow description.");
                            assert!(row.get("content").is_none());
                            row["id"].as_str().unwrap().to_owned()
                        })
                        .collect::<BTreeSet<_>>();
                    assert_eq!(ids, *expected_ids);
                    call("read_skill", json!({"skillId":blocked[0]}))
                }
                2 | 3 => {
                    let denied = latest_tool(&body).unwrap();
                    assert!(denied.contains("当前任务中没有此已审核技能"));
                    assert!(!denied.contains("OTHER_COLLEAGUE_PRIVATE_SKILL"));
                    assert!(!denied.contains("NEW_VERSION_CANARY_FOR_LATER_RUNS"));
                    let target = if step == 2 { &blocked[1] } else { &skill["id"] };
                    call("read_skill", json!({"skillId":target}))
                }
                4 => {
                    let read = result(latest_tool(&body).unwrap());
                    assert_eq!(read["id"], skill["id"]);
                    assert_eq!(read["version"], 1);
                    assert_eq!(read["offset"], 0);
                    assert!(read["nextOffset"].is_null());
                    let actual = read["content"].as_str().unwrap();
                    assert!(actual == skill["content"].as_str().unwrap());
                    assert!(actual.ends_with("SYNTHETIC_METHOD_TAIL_07🚀"));
                    recall("Scoped", None)
                }
                page if page < 32 => {
                    let reply = result(latest_tool(&body).unwrap());
                    if reply["content"] == NEW_MEMORY {
                        assert_eq!(reply["agentId"], actor);
                        return recall(NEW_MEMORY, None);
                    }
                    if reply["total"] == 106 {
                        assert_eq!(reply["matched"], 1);
                        assert_eq!(reply["memories"][0]["content"], NEW_MEMORY);
                        assert!(reply["nextCursor"].is_null());
                        return finish(FINISHED);
                    }
                    assert_eq!(reply["total"], 105);
                    assert_eq!(reply["matched"], 105);
                    let mut ids = seen.lock().await;
                    let entries = reply["memories"].as_array().unwrap();
                    assert!(!entries.is_empty());
                    for row in entries {
                        let id = row["id"].as_str().unwrap();
                        assert_eq!(row["agentId"], actor);
                        assert!(ids.insert(id.to_owned()), "duplicate memory across pages");
                        assert_eq!(row["content"], expected_memories[id]);
                    }
                    if let Some(cursor) = reply["nextCursor"].as_str() {
                        recall("Scoped", Some(cursor))
                    } else {
                        assert_eq!(ids.len(), 105);
                        assert!(page > 5, "memory retrieval should span multiple pages");
                        call("remember", json!({"content":NEW_MEMORY}))
                    }
                }
                _ => panic!("Memory cursor did not terminate"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Read the synthetic workflow and saved context.",
            "followUp",
            false,
        )
        .await;
    wait_gate(&reached).await;
    approve(&group.f, &next_tail, skills.last()).await;
    release.add_permits(1);
    let transcript = group.done().await;
    assert!(
        transcript
            .iter()
            .any(|row| row["status"] == "done" && row["content"] == FINISHED),
        "Long-knowledge work did not complete, model calls {}",
        stage.load(Ordering::SeqCst)
    );
    assert_eq!(memory_seen.lock().await.len(), 105);
    group.close().await;
}
