use super::*;
use crate::workspace::{Table, WorkspaceStore};

fn sample() -> Value {
    json!({"name":"revenue-check","description":"Check a synthetic revenue CSV.",
            "content":"Read references/checklist.md and run scripts/check.py only after approval.","license":"MIT",
            "files":[{"path":"scripts/check.py","content":"print('checked')\n"},
                {"path":"references/checklist.md","content":"Verify row totals and report missing amounts."}]})
}

#[tokio::test]
async fn proposed_package_preserves_files_and_remains_disabled() {
    let directory = tempfile::tempdir().unwrap();
    let store = WorkspaceStore::open(directory.path()).await.unwrap();
    let agent = uuid::Uuid::new_v4().to_string();
    let mut tx = store.begin().await.unwrap();
    let skill = propose(&mut tx, &agent, &sample()).await.unwrap();
    assert_eq!(skill["status"], "proposed");
    assert!(skill["approvedAt"].is_null());
    assert_eq!(skill["skillPackage"]["format"], "agent-skills");
    assert_eq!(skill["skillPackage"]["files"].as_array().unwrap().len(), 3);
    let bytes: Vec<u8> = sqlx::query_scalar(
        "SELECT content FROM skill_package_files WHERE skill_id=? AND path='scripts/check.py'",
    )
    .bind(skill["id"].as_str().unwrap())
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(bytes, b"print('checked')\n");
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn invalid_names_paths_and_collisions_never_persist_a_proposal() {
    let directory = tempfile::tempdir().unwrap();
    let store = WorkspaceStore::open(directory.path()).await.unwrap();
    let agent = uuid::Uuid::new_v4().to_string();
    let before = store.list(Table::Skills).await.unwrap().len();
    for path in [
        "../outside.py",
        "/tmp/check.py",
        "scripts/../../outside.py",
        "SKILL.md",
        "scripts/Check.py",
    ] {
        let mut args = sample();
        args["files"][1]["path"] = json!(path);
        let mut tx = store.begin().await.unwrap();
        assert!(propose(&mut tx, &agent, &args).await.is_err(), "{path}");
        tx.rollback().await.unwrap();
    }
    let mut empty = sample();
    empty["files"] = json!([]);
    assert!(body(&agent, &empty).is_err());
    let mut invalid = sample();
    invalid["name"] = json!("Invalid Name");
    let mut tx = store.begin().await.unwrap();
    assert!(propose(&mut tx, &agent, &invalid).await.is_err());
    tx.rollback().await.unwrap();
    assert_eq!(store.list(Table::Skills).await.unwrap().len(), before);
}

#[test]
fn catalog_reports_provenance_without_installing_or_executing() {
    let result = find(&json!({"query":"frontend-design","language":"en"})).unwrap();
    assert_eq!(result["matched"], 1);
    let item = &result["items"][0];
    assert_eq!(item["status"], "available");
    assert!(item["license"].as_str().unwrap().contains("Apache-2.0"));
    assert!(item["files"].as_array().unwrap().len() > 1);
    assert_eq!(
        find(&json!({"query":"nonexistent-synthetic-skill"})).unwrap()["matched"],
        0
    );
    assert!(find(&json!({"offset":-1})).is_err());
    assert!(find(&json!({"language":"invalid"})).is_err());
}
