mod workspace_support;
use openbot_backend::workspace::{Table, model};
use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn account_workspace_and_operator_boundaries_precede_store_open() {
    let f = Fixture::new().await;
    let (status, _) = f
        .request(
            "GET",
            &format!("/api/workspaces/{}/bootstrap", f.foreign),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 403);
    assert!(!f.directory.path().join("spaces").join(&f.foreign).exists());
    let (status, _) = f
        .with_cookie(
            "GET",
            &f.path("/bootstrap"),
            None,
            &format!("openbot_operator={}", f.operator_token),
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 401);
    let (status, _) = f
        .request("GET", &f.path("/bootstrap"), None, true, Some(&f.owner))
        .await;
    assert_eq!(status, 403);
    let owner = f.bootstrap().await;
    let (status, member) = f
        .request("GET", &f.path("/bootstrap"), None, true, Some(&f.member))
        .await;
    assert_eq!(status, 200);
    assert_eq!(member["agents"], owner["agents"]);
    let (status, _) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(json!({"name":"Forbidden"})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 403);
    assert_eq!(f.bootstrap().await["agents"], owner["agents"]);
    f.close().await;
}
#[tokio::test]
async fn bot_and_dm_creation_are_durable_idempotent_and_member_groups_do_not_grant_bot_creation() {
    let f = Fixture::new().await;
    let original = f.bootstrap().await;
    let request = uuid::Uuid::new_v4().to_string();
    let body = json!({"kind":"bot","requestId":request,"profile":{"name":"Synthetic colleague","role":"Reviewer","color":"#123456","avatar":"gem"}});
    let (status, created) = f
        .request(
            "POST",
            &f.path("/creation-requests"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["status"], "created");
    let (status, replay) = f
        .request(
            "POST",
            &f.path("/creation-requests"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(created, replay);
    let snapshot = f.bootstrap().await;
    assert_eq!(snapshot["agents"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["conversations"].as_array().unwrap().len(), 2);
    let (status, _) = f
        .request(
            "POST",
            &f.path("/creation-requests"),
            Some(body.clone()),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 403);
    let group = json!({"kind":"group","requestId":uuid::Uuid::new_v4().to_string(),"title":"Review group","agentIds":[original["agents"][0]["id"],created["agentIds"][0]]});
    let (status, value) = f
        .request(
            "POST",
            &f.path("/creation-requests"),
            Some(group),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 201, "{value}");
    assert_eq!(value["conversation"]["isGroup"], true);
    let (status, receipt) = f
        .request(
            "GET",
            &f.path(&format!("/creation-requests/{request}")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(receipt, created);
    let mut conflict = body;
    conflict["profile"]["name"] = json!("Different");
    let (status, _) = f
        .request(
            "POST",
            &f.path("/creation-requests"),
            Some(conflict),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    f.close().await;
}
#[tokio::test]
async fn closing_unknown_creation_fences_late_post_and_does_not_stop_accepted_results() {
    let f = Fixture::new().await;
    let _ = f.bootstrap().await;
    let id = uuid::Uuid::new_v4().to_string();
    let (status, closed) = f
        .request(
            "POST",
            &f.path(&format!("/creation-requests/{id}/cancel")),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(closed["status"], "not_submitted");
    let (status, closed) = f
        .request(
            "GET",
            &f.path(&format!("/creation-requests/{id}")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 410);
    assert_eq!(closed["code"], "CREATION_REQUEST_CLOSED");
    let body = json!({"kind":"bot","requestId":id,"profile":{"name":"Late"}});
    let (status, _) = f
        .request(
            "POST",
            &f.path("/creation-requests"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(f.bootstrap().await["agents"].as_array().unwrap().len(), 1);
    f.close().await;
}
#[tokio::test]
async fn bot_revision_conflicts_and_live_session_revocation_never_apply_old_actor_mutations() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let agent = &initial["agents"][0];
    let path = f.path(&format!("/agents/{}", agent["id"].as_str().unwrap()));
    let(status,updated)=f.request("PATCH",&path,Some(json!({"expectedRevision":agent["configRevision"],"name":"Updated","role":"Analyst"})),false,Some(&f.owner)).await;
    assert_eq!(status, 200);
    assert_ne!(updated["configRevision"], agent["configRevision"]);
    let (status, _) = f
        .request(
            "PATCH",
            &path,
            Some(json!({"expectedRevision":agent["configRevision"],"name":"Stale"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(f.bootstrap().await["agents"][0]["name"], "Updated");
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    let (status, _) = f
        .request(
            "PATCH",
            &path,
            Some(json!({"name":"Revoked"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 401);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    assert_eq!(
        store
            .get(Table::Agents, agent["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["name"],
        "Updated"
    );
    f.close().await;
}
#[tokio::test]
async fn model_secrets_stay_in_the_selected_workspace_and_clear_on_endpoint_change() {
    let f = Fixture::new().await;
    let _ = f.bootstrap().await;
    let(status,value)=f.request("POST",&f.path("/model-profiles"),Some(json!({"name":"Synthetic model","provider":"openai","model":"fixture","baseUrl":"http://127.0.0.1:9898/v1","apiKey":"SYNTHETIC_PRIVATE_KEY","activate":true})),false,Some(&f.owner)).await;
    assert_eq!(status, 201, "{value}");
    assert!(!value.to_string().contains("SYNTHETIC_PRIVATE_KEY"));
    assert_eq!(value["settings"]["configured"], true);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    assert_eq!(
        model::runtime_config(&store).await.unwrap()["apiKey"],
        "SYNTHETIC_PRIVATE_KEY"
    );
    let (status, profiles) = f
        .request(
            "GET",
            &f.path("/model-profiles"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert!(!profiles.to_string().contains("SYNTHETIC_PRIVATE_KEY"));
    assert!(
        !f.bootstrap()
            .await
            .to_string()
            .contains("SYNTHETIC_PRIVATE_KEY")
    );
    let (status, _) = f
        .request(
            "POST",
            &f.path("/model-profiles"),
            Some(json!({"id":value["profile"]["id"],"baseUrl":"http://127.0.0.1:9899/v1"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(model::runtime_config(&store).await.unwrap()["apiKey"], "");
    let foreign = f.state.workspace.get(&f.foreign, &f.foreign).await.unwrap();
    assert_eq!(model::runtime_config(&foreign).await.unwrap()["apiKey"], "");
    f.close().await;
}
#[tokio::test]
async fn memories_and_skill_versions_use_real_transactions_with_one_active_version() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let agent = boot["agents"][0]["id"].clone();
    let (status, memory) = f
        .request(
            "POST",
            &f.path("/memories"),
            Some(json!({"agentId":agent,"content":"Synthetic preference","category":"preference"})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 201);
    assert_eq!(memory["category"], "preference");
    let mut versions = Vec::new();
    for content in ["First verified workflow", "Second verified workflow"] {
        let (status, skill) = f
            .request(
                "POST",
                &f.path("/skills"),
                Some(json!({"agentId":agent,"name":"Review","content":content})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 201);
        assert_eq!(skill["status"], "proposed");
        versions.push(skill);
    }
    for skill in &versions {
        let (status, active) = f
            .request(
                "POST",
                &f.path(&format!(
                    "/skills/{}/approve",
                    skill["id"].as_str().unwrap()
                )),
                Some(json!({})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 200, "{active}");
        assert_eq!(active["status"], "active");
    }
    let skills = f.bootstrap().await["skills"].as_array().unwrap().clone();
    assert_eq!(skills.iter().filter(|s| s["status"] == "active").count(), 1);
    assert_eq!(skills[0]["status"], "archived");
    let (status, _) = f
        .request(
            "POST",
            &f.path(&format!(
                "/skills/{}/disable",
                versions[1]["id"].as_str().unwrap()
            )),
            Some(json!({})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 403);
    f.close().await;
}
