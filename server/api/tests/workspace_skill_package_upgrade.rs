mod workspace_support;

use openbot_backend::{db::State, workspace::Table};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use workspace_support::Fixture;

async fn post(f: &Fixture, path: &str, body: Value) -> (u16, Value) {
    f.request("POST", &f.path(path), Some(body), false, Some(&f.owner))
        .await
}

#[tokio::test]
async fn old_text_versions_get_real_packages_without_changing_their_workflow_records() {
    let mut f = Fixture::new().await;
    let agent = f.bootstrap().await["agents"][0]["id"].clone();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut originals = Vec::new();
    for (version, status) in [(1, "archived"), (2, "active"), (3, "proposed")] {
        let row = json!({
            "id":uuid::Uuid::new_v4().to_string(),
            "agentId":agent,"name":"月度 Audit","description":"","content":format!("Review version {version}.\n"),
            "version":version,"status":status,"createdAt":"2026-01-01T00:00:00Z",
        });
        store.put(Table::Skills, &row).await.unwrap();
        originals.push(row);
    }
    let config = (*f.state.config).clone();
    f.state.close().await;
    f.state = State::open(config.clone()).await.unwrap();
    let migrated_all = f.bootstrap().await["skills"].clone();
    let migrated: Vec<_> = migrated_all
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["name"] == "月度 Audit")
        .cloned()
        .collect();
    assert_eq!(migrated.len(), originals.len());
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    for (mut skill, original) in migrated.iter().cloned().zip(originals.iter()) {
        let package = skill
            .as_object_mut()
            .unwrap()
            .remove("skillPackage")
            .unwrap();
        skill.as_object_mut().unwrap().remove("skillPackageSource");
        assert_eq!(&skill, original);
        assert_eq!(package["format"], "agent-skills");
        assert_eq!(package["root"], package["frontmatter"]["name"]);
        assert_eq!(package["root"], migrated[0]["skillPackage"]["root"]);
        assert_eq!(package["frontmatter"]["metadata"]["title"], "月度 Audit");
        assert_eq!(
            package["frontmatter"]["description"],
            "Reusable workflow: 月度 Audit"
        );
        let content: Vec<u8> = sqlx::query_scalar(
            "SELECT content FROM skill_package_files WHERE skill_id=? AND path='SKILL.md'",
        )
        .bind(original["id"].as_str().unwrap())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert!(content.ends_with(original["content"].as_str().unwrap().as_bytes()));
        assert_eq!(
            package["files"][0]["sha256"],
            hex::encode(Sha256::digest(&content))
        );
    }
    f.state.close().await;
    f.state = State::open(config).await.unwrap();
    assert_eq!(f.bootstrap().await["skills"], migrated_all);
    let (code, new) = post(&f, "/skills", json!({
        "agentId":agent,"name":"月度 Audit","description":"","content":"Verify the current data."
    })).await;
    assert_eq!(code, 201, "{new}");
    assert_eq!(new["version"], 4);
    assert_eq!(new["previousVersion"], 3);
    assert_eq!(new["name"], "月度 Audit");
    assert_eq!(new["description"], "");
    assert_eq!(
        new["skillPackage"]["root"],
        migrated[0]["skillPackage"]["root"]
    );
    f.close().await;
}

#[tokio::test]
async fn a_plain_text_update_cannot_discard_a_reviewed_version_with_package_resources() {
    let f = Fixture::new().await;
    let agent = f.bootstrap().await["agents"][0]["id"].clone();
    let mut draft = json!({"agentId":agent,"name":"current-workflow","description":"Use the checklist.","content":"Read references/checklist.md."});
    draft["skillPackage"] = json!({"root":"current-workflow","frontmatter":{},"files":[
        {"path":"references/checklist.md","base64":"VXNlIGZpeHR1cmUgZGF0YS4="}
    ]});
    let (status, version) = post(&f, "/skills", draft.clone()).await;
    assert_eq!(status, 201, "{version}");
    let (status, active) = post(
        &f,
        &format!("/skills/{}/approve", version["id"].as_str().unwrap()),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{active}");
    let before_rejected_update = f.bootstrap().await["skills"].clone();
    let mut blind_update = draft.clone();
    blind_update.as_object_mut().unwrap().remove("skillPackage");
    blind_update["content"] = json!("Update text without the package.");
    let (status, rejected) = post(&f, "/skills", blind_update).await;
    assert_eq!(status, 409, "{rejected}");
    assert_eq!(rejected["code"], "SKILL_PACKAGE_REQUIRED");
    assert_eq!(f.bootstrap().await["skills"], before_rejected_update);
    draft["content"] = json!("Read the new details in references/checklist.md.");
    let (status, replacement) = post(&f, "/skills", draft).await;
    assert_eq!(status, 201, "{replacement}");
    assert_eq!(replacement["version"], 2);
    assert_eq!(
        replacement["skillPackage"]["files"][1],
        active["skillPackage"]["files"][1]
    );
    f.close().await;
}
