mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn personal_roster_is_member_owned_and_bootstrap_never_returns_another_actor_preferences() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let agent = &initial["agents"][0]["id"];
    let body = json!({"expectedRevision":"unset","operation":{"type":"set-entry","target":{"kind":"bot","id":agent},"hidden":true,"pinned":true}});
    let (status, member) = f
        .request(
            "PUT",
            &f.path("/sidebar-roster"),
            Some(body),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200, "{member}");
    assert_eq!(member["entries"][0]["hidden"], true);
    assert_eq!(
        f.bootstrap().await["sidebarRoster"],
        initial["sidebarRoster"]
    );
    let (status, own) = f
        .request("GET", &f.path("/bootstrap"), None, true, Some(&f.member))
        .await;
    assert_eq!(status, 200);
    assert_eq!(own["sidebarRoster"], member);
    let (status, _) = f
        .request(
            "GET",
            &f.path("/sidebar-roster"),
            None,
            true,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 403);
    let (status, _) = f
        .request("GET", &f.path("/sidebar-roster"), None, true, None)
        .await;
    assert_eq!(status, 403);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let conversation = &initial["conversations"][0];
    assert_eq!(
        store
            .get(Table::Conversations, conversation["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["pinned"],
        false
    );
    f.close().await;
}
#[tokio::test]
async fn roster_cas_and_sections_persist_without_global_pin_writes() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let agent = &initial["agents"][0]["id"];
    let body = json!({"expectedRevision":"unset","operation":{"type":"create-section","name":"Personal projects","target":{"kind":"bot","id":agent}}});
    let (status, created) = f
        .request(
            "PUT",
            &f.path("/sidebar-roster"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(created["sections"].as_array().unwrap().len(), 1);
    let (status, stale) = f
        .request(
            "PUT",
            &f.path("/sidebar-roster"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(stale["code"], "SIDEBAR_ROSTER_CONFLICT");
    let(status,deleted)=f.request("PUT",&f.path("/sidebar-roster"),Some(json!({"expectedRevision":created["revision"],"operation":{"type":"delete-section","id":created["sections"][0]["id"]}})),false,Some(&f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(deleted["entries"], json!([]));
    assert_eq!(deleted["sections"], json!([]));
    let chat = &initial["conversations"][0];
    let (status, _) = f
        .request(
            "PATCH",
            &f.path(&format!("/conversations/{}", chat["id"].as_str().unwrap())),
            Some(json!({"title":"Do not partially change","pinned":true})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(
        f.bootstrap().await["conversations"][0]["title"],
        chat["title"]
    );
    f.close().await;
}
#[tokio::test]
async fn first_read_projects_legacy_pin_without_writing_and_later_user_state_is_independent() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut chat = initial["conversations"][0].clone();
    chat["pinned"] = json!(true);
    store.put(Table::Conversations, &chat).await.unwrap();
    let read = f.bootstrap().await["sidebarRoster"].clone();
    assert_eq!(read["revision"], "unset");
    assert_eq!(read["entries"][0]["target"]["kind"], "bot");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sidebar_rosters")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let(status,own)=f.request("PUT",&f.path("/sidebar-roster"),Some(json!({"expectedRevision":"unset","operation":{"type":"set-entry","target":read["entries"][0]["target"],"pinned":false}})),false,Some(&f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(own["entries"], json!([]));
    assert_eq!(f.bootstrap().await["sidebarRoster"], own);
    let (status, member) = f
        .request(
            "GET",
            &f.path("/sidebar-roster"),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(member["entries"][0]["pinned"], true);
    f.close().await;
}
