mod agent_delegation_support;
mod knowledge_acceptance_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish};
use knowledge_acceptance_support::latest_tool;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Mutex;

fn package() -> Value {
    json!({"name":"audit-authored-package","description":"Review synthetic data.",
    "content":"Read references/schema.md before reviewing. Do not execute this proposal.",
    "license":"MIT","files":[
        {"path":"scripts/review.py","content":"raise RuntimeError('PROPOSAL_MUST_NOT_EXECUTE')\n"},
        {"path":"references/schema.md","content":"Synthetic fields only."}
    ]})
}

#[tokio::test]
async fn actual_tool_path_rejects_unsafe_packages_and_keeps_successive_versions_proposed() {
    let group = Group::new().await;
    let initial = group.store.list(Table::Skills).await.unwrap().len();
    let mut cases = Vec::new();
    for path in [
        "../outside.py",
        "/tmp/outside.py",
        "SKILL.md",
        "scripts/REVIEW.py",
    ] {
        let mut invalid = package();
        invalid["files"][1]["path"] = json!(path);
        cases.push(invalid);
    }
    let mut empty = package();
    empty["files"] = json!([]);
    cases.push(empty);
    let mut oversized = package();
    oversized["files"][0]["content"] = json!("a".repeat(256 * 1024 + 1));
    cases.push(oversized);
    let invalid_count = cases.len();
    cases.push(package());
    let mut next = package();
    next["files"][1]["content"] = json!("Second synthetic schema.");
    cases.push(next);
    let calls = Arc::new(AtomicUsize::new(0));
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let captured = receipts.clone();
    let model = Model::new(Arc::new(move |body| {
        let index = calls.fetch_add(1, Ordering::SeqCst);
        let next = cases.get(index).cloned();
        let receipts = captured.clone();
        Box::pin(async move {
            if let Some(receipt) = latest_tool(&body) {
                receipts.lock().await.push(receipt.to_owned());
            }
            next.map_or_else(
                || finish("Authoring review finished."),
                |args| call("propose_skill", args),
            )
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Exercise proposed package validation using synthetic input only.",
            "steer",
            false,
        )
        .await;
    let messages = group.done().await;
    assert!(
        messages
            .iter()
            .any(|m| m["content"] == "Authoring review finished.")
    );
    let all = group.store.list(Table::Skills).await.unwrap();
    assert_eq!(all.len(), initial + 2);
    let mut authored: Vec<_> = all
        .into_iter()
        .filter(|s| s["name"] == "audit-authored-package")
        .collect();
    authored.sort_by_key(|s| s["version"].as_u64().unwrap());
    assert_eq!(authored.len(), 2);
    for (index, skill) in authored.iter().enumerate() {
        assert_eq!(skill["status"], "proposed");
        assert!(skill["approvedAt"].is_null());
        assert_eq!(skill["version"], index + 1);
        assert_eq!(skill["agentId"], group.ids[0]);
        let bytes: Vec<u8> = sqlx::query_scalar(
            "SELECT content FROM skill_package_files WHERE skill_id=? AND path='scripts/review.py'",
        )
        .bind(skill["id"].as_str().unwrap())
        .fetch_one(&group.store.pool)
        .await
        .unwrap();
        assert_eq!(bytes, b"raise RuntimeError('PROPOSAL_MUST_NOT_EXECUTE')\n");
    }
    assert_eq!(authored[1]["previousVersion"], 1);
    let receipts = receipts.lock().await;
    assert_eq!(receipts.len(), invalid_count + 2);
    for rejected in receipts.iter().take(invalid_count) {
        assert!(!rejected.contains("\"status\":\"proposed\""));
    }
    assert!(!messages.iter().any(|m| m["kind"] == "computer"));
    group.close().await;
}
