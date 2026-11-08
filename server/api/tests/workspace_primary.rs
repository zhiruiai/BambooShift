mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use workspace_support::Fixture;

async fn personal() -> Fixture {
    let f = Fixture::new().await;
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    f
}
#[tokio::test]
async fn primary_selection_is_personal_only_and_switching_is_cas_without_extra_dm() {
    let f = personal().await;
    let boot = f.bootstrap().await;
    let agent = &boot["agents"][0];
    let before = &boot["primaryBot"];
    assert_eq!(before["revision"], "unset");
    let body = json!({"mode":"select","expectedRevision":"unset","agentId":agent["id"],"checkIn":{"enabled":false,"time":"09:00","timeZone":"America/New_York"}});
    let (status, selected) = f
        .request(
            "PUT",
            &f.path("/primary-bot"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{selected}");
    assert_eq!(selected["conversationId"], boot["conversations"][0]["id"]);
    assert_eq!(
        f.bootstrap().await["conversations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (status, _) = f
        .request(
            "PUT",
            &f.path("/primary-bot"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    let (status, cleared) = f
        .request(
            "PUT",
            &f.path("/primary-bot"),
            Some(json!({"mode":"clear","expectedRevision":selected["revision"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert!(cleared["agentId"].is_null());
    assert_eq!(cleared["checkIn"]["enabled"], false);
    f.close().await;
    let team = Fixture::new().await;
    let boot = team.bootstrap().await;
    assert_eq!(boot["primaryBot"]["available"], false);
    let (status, _) = team
        .request(
            "PUT",
            &team.path("/primary-bot"),
            Some(json!({"mode":"clear","expectedRevision":"unset"})),
            false,
            Some(&team.owner),
        )
        .await;
    assert_eq!(status, 403);
    team.close().await;
}
#[tokio::test]
async fn primary_creation_deletion_and_rejection_are_atomic_and_shared_alias_cannot_be_primary() {
    let f = personal().await;
    let boot = f.bootstrap().await;
    let body = json!({"mode":"create","expectedRevision":"unset","bot":{"name":"Primary"},"checkIn":{"enabled":false,"time":"08:30"}});
    let (status, created) = f
        .request(
            "PUT",
            &f.path("/primary-bot"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(f.bootstrap().await["agents"].as_array().unwrap().len(), 2);
    let (status, _) = f
        .request(
            "DELETE",
            &f.path(&format!("/agents/{}", created["agentId"].as_str().unwrap())),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    let after = f.bootstrap().await;
    assert!(after["primaryBot"]["agentId"].is_null());
    assert_eq!(after["primaryBot"]["checkIn"]["enabled"], false);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut bot = boot["agents"][0].clone();
    bot["sharedBot"] = json!({"shareId":uuid::Uuid::new_v4().to_string()});
    store.put(Table::Agents, &bot).await.unwrap();
    let(status,_)=f.request("PUT",&f.path("/primary-bot"),Some(json!({"mode":"select","expectedRevision":after["primaryBot"]["revision"],"agentId":bot["id"],"checkIn":{"enabled":false,"time":"09:00"}})),false,Some(&f.owner)).await;
    assert_eq!(status, 403);
    assert_eq!(f.bootstrap().await["primaryBot"], after["primaryBot"]);
    f.close().await;
}
