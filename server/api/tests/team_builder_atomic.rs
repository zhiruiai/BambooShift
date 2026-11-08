mod team_builder_support;
mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use team_builder_support::*;
use workspace_support::Fixture;

#[tokio::test]
async fn competing_commits_and_late_revise_cannot_duplicate_or_reopen_a_team() {
    let f = Fixture::new().await;
    let plan = seed(&f, proposal()).await;
    let id = plan["id"].as_str().unwrap();
    let path = f.path(&format!("/bot-team-plans/{id}/commit"));
    let input = commit(&plan);
    let (a, b) = tokio::join!(
        f.request("POST", &path, Some(input.clone()), false, Some(&f.owner)),
        f.request("POST", &path, Some(input.clone()), false, Some(&f.owner))
    );
    assert_eq!(a.0, 200, "{}", a.1);
    assert_eq!(b, a);
    let revise = f.path(&format!("/bot-team-plans/{id}/revise"));
    assert_eq!(
        f.request(
            "POST",
            &revise,
            Some(json!({"expectedRevision":plan["revision"],"draft":plan["draft"]})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    assert_eq!(
        f.request("POST", &path, Some(commit(&plan)), false, Some(&f.owner))
            .await
            .0,
        409
    );
    let boot = f.bootstrap().await;
    assert_eq!(boot["agents"].as_array().unwrap().len(), 3);
    assert_eq!(boot["conversations"].as_array().unwrap().len(), 4);
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!("/bot-team-plans/{id}/cancel")),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    f.close().await;
}
#[tokio::test]
async fn group_failure_rolls_back_new_bots_dms_avatar_publication_and_receipt() {
    let f = Fixture::new().await;
    f.bootstrap().await;
    let ws = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let image = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO avatar_assets VALUES(?,'{}',x'524946463030303057454250',0)")
        .bind(&image)
        .execute(&ws.pool)
        .await
        .unwrap();
    let mut draft = proposal();
    draft["members"][0]["avatarImageId"] = json!(image);
    let plan = seed(&f, draft).await;
    let id = plan["id"].as_str().unwrap();
    sqlx::query("CREATE TRIGGER fail_group BEFORE INSERT ON conversations WHEN json_extract(NEW.data,'$.isGroup')=1 BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&ws.pool).await.unwrap();
    let body = commit(&plan);
    let path = f.path(&format!("/bot-team-plans/{id}/commit"));
    assert_eq!(
        f.request("POST", &path, Some(body.clone()), false, Some(&f.owner))
            .await
            .0,
        500
    );
    assert_eq!(ws.list(Table::Agents).await.unwrap().len(), 1);
    assert_eq!(ws.list(Table::Conversations).await.unwrap().len(), 1);
    let published: i64 = sqlx::query_scalar("SELECT published FROM avatar_assets WHERE id=?")
        .bind(&image)
        .fetch_one(&ws.pool)
        .await
        .unwrap();
    assert_eq!(published, 0);
    let current = f
        .request(
            "GET",
            &f.path(&format!("/bot-team-plans/{id}")),
            None,
            false,
            Some(&f.owner),
        )
        .await
        .1;
    assert_eq!(current, plan);
    sqlx::query("DROP TRIGGER fail_group")
        .execute(&ws.pool)
        .await
        .unwrap();
    assert_eq!(
        f.request("POST", &path, Some(body), false, Some(&f.owner))
            .await
            .0,
        200
    );
    let published: i64 = sqlx::query_scalar("SELECT published FROM avatar_assets WHERE id=?")
        .bind(&image)
        .fetch_one(&ws.pool)
        .await
        .unwrap();
    assert_eq!(published, 1);
    f.close().await;
}
#[tokio::test]
async fn review_binds_displayed_profiles_draft_and_revision_and_receipt_returns_current_plan() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let mut draft = proposal();
    draft["members"][0] =
        json!({"key":"a","kind":"reuse","agentId":boot["agents"][0]["id"],"assignment":"lead"});
    let plan = seed(&f, draft).await;
    let id = plan["id"].as_str().unwrap();
    let reviewpath = f.path(&format!("/bot-team-plans/{id}/review-bots"));
    let body = json!({"expectedRevision":plan["revision"],"draft":plan["draft"]});
    let (status, first) = f
        .request(
            "POST",
            &reviewpath,
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["members"][0]["state"], "added");
    let ws = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut bot = boot["agents"][0].clone();
    bot["description"] = json!("Changed reviewed information");
    ws.put(Table::Agents, &bot).await.unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let mut refresh = body.clone();
    refresh["requestId"] = json!(request);
    refresh["reviewToken"] = first["reviewToken"].clone();
    let path = f.path(&format!("/bot-team-plans/{id}/refresh-bots"));
    assert_eq!(
        f.request("POST", &path, Some(refresh.clone()), false, Some(&f.owner))
            .await
            .0,
        409
    );
    let (status, latest) = f
        .request(
            "POST",
            &reviewpath,
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_ne!(latest["reviewToken"], first["reviewToken"]);
    refresh["reviewToken"] = latest["reviewToken"].clone();
    let mut altered = refresh.clone();
    altered["draft"]["summary"] = json!("Not what was reviewed");
    assert_eq!(
        f.request("POST", &path, Some(altered), false, Some(&f.owner))
            .await
            .0,
        409
    );
    let (status, accepted) = f
        .request("POST", &path, Some(refresh.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(status, 200, "{accepted}");
    assert_ne!(accepted["appliedRevision"], plan["revision"]);
    let (status, cancelled) = f
        .request(
            "POST",
            &f.path(&format!("/bot-team-plans/{id}/cancel")),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    let repeated = f
        .request("POST", &path, Some(refresh), false, Some(&f.owner))
        .await;
    assert_eq!(repeated.0, 200);
    assert_eq!(repeated.1["plan"], cancelled);
    assert_eq!(repeated.1["appliedRevision"], accepted["appliedRevision"]);
    let receipt = f
        .request(
            "GET",
            &f.path(&format!("/bot-team-plans/{id}/catalog-refreshes/{request}")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(receipt, repeated);
    assert_eq!(f.bootstrap().await["agents"].as_array().unwrap().len(), 1);
    f.close().await;
}
#[tokio::test]
async fn invalid_members_and_legacy_single_member_never_create_partial_teams() {
    let f = Fixture::new().await;
    let mut draft = proposal();
    draft["members"].as_array_mut().unwrap().truncate(1);
    let plan = seed(&f, draft).await;
    let id = plan["id"].as_str().unwrap();
    let path = f.path(&format!("/bot-team-plans/{id}/commit"));
    assert_eq!(
        f.request("POST", &path, Some(commit(&plan)), false, Some(&f.owner))
            .await
            .0,
        400
    );
    let mut corrected = plan["draft"].clone();
    corrected["members"]
        .as_array_mut()
        .unwrap()
        .push(member("b", "Extra"));
    let (status, revised) = f
        .request(
            "POST",
            &f.path(&format!("/bot-team-plans/{id}/revise")),
            Some(json!({"expectedRevision":plan["revision"],"draft":corrected})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{revised}");
    assert_eq!(
        f.request("POST", &path, Some(commit(&plan)), false, Some(&f.owner))
            .await
            .0,
        409
    );
    assert_eq!(
        f.request("POST", &path, Some(commit(&revised)), false, Some(&f.owner))
            .await
            .0,
        200
    );
    f.close().await;
}
#[tokio::test]
async fn persisted_generating_work_is_interrupted_on_reopen_without_model_replay() {
    let mut f = Fixture::new().await;
    let plan = seed(&f, proposal()).await;
    let ws = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE bot_team_plans SET data=json_set(data,'$.plan.status','generating') WHERE id=?",
    )
    .bind(plan["id"].as_str())
    .execute(&ws.pool)
    .await
    .unwrap();
    f.state.close().await;
    f.state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        f.directory.path(),
    ))
    .await
    .unwrap();
    let (status, restored) = f
        .request(
            "GET",
            &f.path(&format!("/bot-team-plans/{}", plan["id"].as_str().unwrap())),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(restored["status"], "error");
    assert_eq!(restored["goal"], plan["goal"]);
    assert_eq!(f.bootstrap().await["agents"].as_array().unwrap().len(), 1);
    f.close().await;
}
