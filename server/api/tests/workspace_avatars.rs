mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn existing_avatar_assets_publish_atomically_with_bot_and_reject_foreign_ids() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let avatar = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO avatar_assets(id,data,bytes,published) VALUES(?,?,?,0)").bind(&avatar).bind(json!({"id":avatar,"width":512,"height":512,"mimeType":"image/webp","createdAt":"2026-01-01T00:00:00.000Z"}).to_string()).bind(b"RIFF0000WEBPsynthetic".to_vec()).execute(&store.pool).await.unwrap();
    let path = f.path(&format!("/bot-avatars/{avatar}"));
    let (status, _) = f.request("GET", &path, None, true, Some(&f.member)).await;
    assert_eq!(status, 403);
    let agent = &boot["agents"][0];
    let agent_path = f.path(&format!("/agents/{}", agent["id"].as_str().unwrap()));
    let (status, _) = f
        .request(
            "PATCH",
            &agent_path,
            Some(json!({"expectedRevision":"stale","avatarImageId":avatar,"name":"Stale"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    let published: i64 = sqlx::query_scalar("SELECT published FROM avatar_assets WHERE id=?")
        .bind(&avatar)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(published, 0);
    let (status, saved) = f
        .request(
            "PATCH",
            &agent_path,
            Some(json!({"expectedRevision":agent["configRevision"],"avatarImageId":avatar})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["avatarImageId"], avatar);
    let (status, _) = f.request("GET", &path, None, true, Some(&f.member)).await;
    assert_eq!(status, 200);
    let unknown = uuid::Uuid::new_v4().to_string();
    let (status, _) = f
        .request(
            "PATCH",
            &agent_path,
            Some(json!({"expectedRevision":saved["configRevision"],"avatarImageId":unknown})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(
        store
            .get(Table::Agents, agent["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["avatarImageId"],
        avatar
    );
    f.close().await;
}
