mod workspace_support;

use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use workspace_support::Fixture;

async fn post(f: &Fixture, path: &str, body: Value) -> (u16, Value) {
    f.request("POST", &f.path(path), Some(body), false, Some(&f.owner))
        .await
}

fn request(id: &str, language: &str) -> Value {
    json!({"id":id,"language":language,"requestId":uuid::Uuid::new_v4().to_string()})
}

async fn start_team(f: &Fixture) -> Value {
    let (status, plan) = post(
        f,
        "/bot-team-plans",
        json!({"requestId":uuid::Uuid::new_v4().to_string(),"goal":"Review a synthetic launch",
            "template":{"id":"launch","language":"en"}}),
    )
    .await;
    assert_eq!(status, 202, "{plan}");
    assert_eq!(plan["status"], "ready");
    assert_eq!(plan["starterSkills"]["brief"][0]["id"], "work-coordination");
    assert_eq!(plan["starterSkills"]["copy"][0]["id"], "editorial-review");
    assert_eq!(plan["starterSkills"]["review"][0]["id"], "release-review");
    assert!(plan["draft"].get("starterSkills").is_none());
    plan
}

#[tokio::test]
async fn starter_install_is_owner_only_idempotent_and_saves_real_package_resources() {
    let f = Fixture::new().await;
    let baseline = f.bootstrap().await;
    let body = request("research", "zh-CN");
    assert_eq!(
        f.request(
            "POST",
            &f.path("/starter-bots"),
            Some(body.clone()),
            true,
            Some(&f.member),
        )
        .await
        .0,
        403,
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/starter-bots"),
            Some(body.clone()),
            false,
            None
        )
        .await
        .0,
        403,
    );
    assert_eq!(
        post(&f, "/starter-bots", request("unsupported", "en"))
            .await
            .0,
        400
    );
    let (first, retry) = tokio::join!(
        post(&f, "/starter-bots", body.clone()),
        post(&f, "/starter-bots", body.clone())
    );
    let mut statuses = [first.0, retry.0];
    statuses.sort();
    assert_eq!(statuses, [200, 201], "{first:?} {retry:?}");
    assert_eq!(first.1, retry.1);
    let installed = first.1;
    let agent_id = &installed["agent"]["id"];
    let skill = &installed["skills"][0];
    assert_eq!(installed["conversation"]["isGroup"], false);
    assert_eq!(installed["conversation"]["agentIds"], json!([agent_id]));
    assert_eq!(skill["name"], "evidence-review");
    assert_eq!(skill["agentId"], *agent_id);
    assert_eq!(skill["status"], "active");
    assert_eq!(skill["version"], 1);
    assert_eq!(skill["approvedAt"], skill["activatedAt"]);
    assert_eq!(skill["skillPackage"]["format"], "agent-skills");
    assert_eq!(skill["skillPackage"]["root"], "evidence-review");
    assert_eq!(
        skill["skillPackage"]["frontmatter"]["metadata"]["title"],
        "证据核查"
    );
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let stored: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT path,content FROM skill_package_files WHERE skill_id=? ORDER BY path",
    )
    .bind(skill["id"].as_str().unwrap())
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(stored.len(), 3);
    assert_eq!(stored[0].0, "SKILL.md");
    assert_eq!(stored[1].0, "assets/claims.csv");
    assert_eq!(stored[2].0, "references/checklist.md");
    for ((path, content), manifest) in stored
        .iter()
        .zip(skill["skillPackage"]["files"].as_array().unwrap())
    {
        assert_eq!(manifest["path"], *path);
        assert_eq!(manifest["size"], content.len());
        assert_eq!(manifest["sha256"], hex::encode(Sha256::digest(content)));
    }
    assert!(
        std::str::from_utf8(&stored[0].1)
            .unwrap()
            .contains("references/checklist.md")
    );
    assert!(
        std::str::from_utf8(&stored[1].1)
            .unwrap()
            .starts_with("claim,source_url,location")
    );
    assert!(
        std::str::from_utf8(&stored[2].1)
            .unwrap()
            .contains("关键主张")
    );
    let mut different_body = body.clone();
    different_body["language"] = json!("en");
    assert_eq!(post(&f, "/starter-bots", different_body).await.0, 409);
    let after = f.bootstrap().await;
    for field in ["agents", "conversations", "skills"] {
        assert_eq!(
            after[field].as_array().unwrap().len(),
            baseline[field].as_array().unwrap().len() + 1
        );
    }
    for field in ["messages", "routines", "apps", "settings"] {
        assert_eq!(after[field], baseline[field], "{field}");
    }
    f.close().await;
}

#[tokio::test]
async fn failed_package_write_rolls_back_everything_and_retry_uses_same_request() {
    let f = Fixture::new().await;
    let before = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_starter_checklist BEFORE INSERT ON skill_package_files WHEN NEW.path='references/checklist.md' BEGIN SELECT RAISE(ABORT,'synthetic package failure'); END")
        .execute(&store.pool).await.unwrap();
    let body = request("engineering", "en");
    assert_eq!(post(&f, "/starter-bots", body.clone()).await.0, 500);
    let after = f.bootstrap().await;
    for field in ["agents", "conversations", "skills", "messages", "routines"] {
        assert_eq!(after[field], before[field], "{field}");
    }
    for table in ["skill_package_files", "creation_requests"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    sqlx::query("DROP TRIGGER fail_starter_checklist")
        .execute(&store.pool)
        .await
        .unwrap();
    let (status, installed) = post(&f, "/starter-bots", body).await;
    assert_eq!(status, 201, "{installed}");
    assert_eq!(installed["skills"][0]["name"], "code-delivery");
    f.close().await;
}

#[tokio::test]
async fn team_commit_provisions_only_reviewed_exact_stock_members() {
    let f = Fixture::new().await;
    let before = f.bootstrap().await;
    let plan = start_team(&f).await;
    let id = plan["id"].as_str().unwrap();
    let mut draft = plan["draft"].clone();
    draft["title"] = json!("Edited Launch");
    draft["members"][1]["instructions"] = json!("Customized editorial responsibilities");
    draft["members"][2] = json!({"kind":"reuse","key":"review","agentId":before["agents"][0]["id"],
        "assignment":"Review the launch with the existing Bot"});
    assert_eq!(f.bootstrap().await["skills"], before["skills"]);
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRevision":plan["revision"],"draft":draft});
    let path = format!("/bot-team-plans/{id}/commit");
    let (status, committed) = post(&f, &path, body.clone()).await;
    assert_eq!(status, 200, "{committed}");
    assert_eq!(
        committed["starterSkills"],
        json!({"brief":plan["starterSkills"]["brief"]})
    );
    let after = f.bootstrap().await;
    let skills = after["skills"].as_array().unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(
        skills[0]["agentId"],
        committed["result"]["createdAgentIds"][0]
    );
    assert_eq!(skills[0]["name"], "work-coordination");
    assert_eq!(skills[0]["status"], "active");
    assert_eq!(post(&f, &path, body).await, (200, committed));
    assert_eq!(f.bootstrap().await["skills"], after["skills"]);
    assert_eq!(after["messages"], before["messages"]);
    f.close().await;
}

#[tokio::test]
async fn team_requires_review_again_when_the_bound_package_version_changes() {
    let f = Fixture::new().await;
    let plan = start_team(&f).await;
    let id = plan["id"].as_str().unwrap();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM bot_team_plans WHERE id=?")
        .bind(id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let mut saved: Value = serde_json::from_str(&raw).unwrap();
    saved["starterSkillFingerprints"]["brief"][0] = json!("synthetic-previous-version");
    sqlx::query("UPDATE bot_team_plans SET data=? WHERE id=?")
        .bind(saved.to_string())
        .bind(id)
        .execute(&store.pool)
        .await
        .unwrap();
    let path = format!("/bot-team-plans/{id}/commit");
    let request_id = uuid::Uuid::new_v4().to_string();
    let (status, rejected) = post(
        &f,
        &path,
        json!({"requestId":request_id,"expectedRevision":plan["revision"],"draft":plan["draft"]}),
    )
    .await;
    assert_eq!(status, 409, "{rejected}");
    assert_eq!(rejected["code"], "STARTER_SKILL_PLAN_CHANGED");
    assert!(store.list(Table::Skills).await.unwrap().is_empty());
    let (status, revised) = post(
        &f,
        &format!("/bot-team-plans/{id}/revise"),
        json!({"expectedRevision":plan["revision"],"draft":plan["draft"]}),
    )
    .await;
    assert_eq!(status, 200, "{revised}");
    assert_eq!(revised["starterSkills"], plan["starterSkills"]);
    let (status, result) = post(
        &f, &path,
        json!({"requestId":request_id,"expectedRevision":revised["revision"],"draft":revised["draft"]}),
    ).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(store.list(Table::Skills).await.unwrap().len(), 3);
    f.close().await;
}
