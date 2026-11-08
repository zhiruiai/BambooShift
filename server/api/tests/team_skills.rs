mod workspace_support;

use serde_json::{Value, json};
use workspace_support::Fixture;

async fn personal_workspace(f: &Fixture, user: &str, name: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO workspaces VALUES(?,?,'personal','active',?,1)")
        .bind(&id)
        .bind(name)
        .bind(&id)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',1)")
        .bind(&id)
        .bind(user)
        .execute(&f.db)
        .await
        .unwrap();
    id
}

async fn published(f: &Fixture, source_bot: &Value, text: &str, prior: Option<&Value>) -> Value {
    let (status, skill) = f
        .request(
            "POST",
            &f.path("/skills"),
            Some(json!({"agentId":source_bot,"name":"Evidence review","description":"Check sources","content":text})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{skill}");
    let skill_id = skill["id"].as_str().unwrap();
    let (status, active) = f
        .request(
            "POST",
            &f.path(&format!("/skills/{skill_id}/approve")),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{active}");
    let (status, publication) = f
        .request(
            "POST",
            &f.path("/team-skills"),
            Some(
                json!({"skillId":skill_id,"expectedRevision":prior.map(|item| &item["revision"])}),
            ),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{publication}");
    publication
}

#[tokio::test]
async fn a_team_member_imports_only_to_their_personal_bot_and_replays_the_same_receipt() {
    let f = Fixture::new().await;
    let personal = personal_workspace(&f, &f.member, "My personal space").await;
    let other_personal = personal_workspace(&f, &f.owner, "Other personal space").await;
    let boot_path = format!("/api/workspaces/{personal}/bootstrap");
    let (status, boot) = f
        .request("GET", &boot_path, None, true, Some(&f.member))
        .await;
    assert_eq!(status, 200, "{boot}");
    let local_bot = &boot["agents"][0];
    let team_bot = f.bootstrap().await["agents"][0]["id"].clone();
    let skill = published(&f, &team_bot, "Use a primary source.", None).await;
    let publication_id = skill["id"].as_str().unwrap();
    let import_path = f.path(&format!("/team-skills/{publication_id}/import"));
    let (status, targets) = f
        .request(
            "GET",
            &f.path("/team-skills/import-targets"),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        targets,
        json!([{"workspaceId":personal,"workspaceName":"My personal space",
                "agents":[{"id":local_bot["id"],"name":local_bot["name"]}]}]),
    );

    let input = json!({"agentId":local_bot["id"],"expectedRevision":skill["revision"]});
    assert_eq!(
        f.request(
            "POST",
            &import_path,
            Some(input.clone()),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403,
    );
    for forbidden in [&f.foreign, &other_personal] {
        let mut body = input.clone();
        body["targetWorkspaceId"] = json!(forbidden);
        assert_eq!(
            f.request("POST", &import_path, Some(body), true, Some(&f.member))
                .await
                .0,
            403,
        );
    }

    let mut body = input;
    body["targetWorkspaceId"] = json!(personal);
    let mut wrong_bot = body.clone();
    wrong_bot["agentId"] = team_bot.clone();
    assert_eq!(
        f.request("POST", &import_path, Some(wrong_bot), true, Some(&f.member))
            .await
            .0,
        404,
    );
    let ((first_status, imported), (second_status, replay)) = tokio::join!(
        f.request(
            "POST",
            &import_path,
            Some(body.clone()),
            true,
            Some(&f.member)
        ),
        f.request(
            "POST",
            &import_path,
            Some(body.clone()),
            true,
            Some(&f.member)
        ),
    );
    assert_eq!(
        (first_status, second_status),
        (200, 200),
        "{imported} {replay}"
    );
    assert_eq!(imported, replay);
    assert_eq!(imported["agentId"], local_bot["id"]);
    assert_eq!(imported["status"], "proposed");
    assert_eq!(imported["content"], "Use a primary source.");
    assert_eq!(
        imported["teamSource"],
        json!({"id":skill["id"],"revision":skill["revision"],"version":1,"workspaceId":f.workspace})
    );
    let wrong_team = format!(
        "/api/workspaces/{}/team-skills/{publication_id}/import",
        f.foreign
    );
    assert_eq!(
        f.request(
            "POST",
            &wrong_team,
            Some(body.clone()),
            true,
            Some(&f.member)
        )
        .await
        .0,
        409,
    );
    let (_, saved) = f
        .request("GET", &boot_path, None, true, Some(&f.member))
        .await;
    assert_eq!(saved["skills"], json!([imported]));
    assert_eq!(f.bootstrap().await["skills"].as_array().unwrap().len(), 1);

    let updated = published(&f, &team_bot, "Compare two primary sources.", Some(&skill)).await;
    assert_ne!(updated["revision"], skill["revision"]);
    let mut stale = body.clone();
    stale["targetWorkspaceId"] = json!(other_personal);
    let (_, other_boot) = f
        .request(
            "GET",
            &format!("/api/workspaces/{other_personal}/bootstrap"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    stale["agentId"] = other_boot["agents"][0]["id"].clone();
    let (status, denied) = f
        .request("POST", &import_path, Some(stale), false, Some(&f.owner))
        .await;
    assert_eq!(status, 409);
    assert_eq!(denied["code"], "TEAM_SKILL_REVISION");

    let (status, team_recipient) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(
                json!({"name":"Team recipient","role":"Reviewer","color":"#123456","avatar":"gem"}),
            ),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{team_recipient}");
    let (status, team_copy) = f
        .request(
            "POST",
            &import_path,
            Some(json!({"agentId":team_recipient["id"],"expectedRevision":updated["revision"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{team_copy}");
    assert_eq!(team_copy["status"], "proposed");
    assert!(team_copy["teamSource"].get("workspaceId").is_none());

    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.request("POST", &import_path, Some(body), true, Some(&f.member))
            .await
            .0,
        403,
    );
    assert_eq!(
        f.request(
            "GET",
            &f.path("/team-skills/import-targets"),
            None,
            true,
            Some(&f.member)
        )
        .await
        .0,
        403,
    );
    let (_, saved) = f
        .request("GET", &boot_path, None, true, Some(&f.member))
        .await;
    assert_eq!(saved["skills"], json!([imported]));
    f.close().await;
}
