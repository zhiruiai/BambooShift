mod workspace_support;
use openbot_backend::{db::State, workspace::Table};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use workspace_support::Fixture;

fn builtin(id: &str) -> Value {
    json!({"avatarTheme":id,"customAvatarTheme":null,"useCustomAvatarTheme":false})
}
fn recipe() -> Value {
    json!({"name":"  Personal stars  ","motif":"pandas","colors":["#AABBCC","#112233","#445566"],"badge":"star","backdrop":"halo"})
}

#[tokio::test]
async fn community_catalog_themes_round_trip_and_unknown_ids_are_rejected() {
    let f = Fixture::new().await;
    let path = f.path("/avatar-theme");
    let catalog: Value =
        serde_json::from_str(include_str!("../../../shared/avatar-packs/catalog.json")).unwrap();
    let mut revision = 0;
    for pack in catalog["packs"].as_array().unwrap() {
        for entry in pack["themes"].as_array().unwrap() {
            let id = entry["id"].as_str().unwrap();
            let mut custom = recipe();
            custom["motif"] = json!(id);
            let value =
                json!({"avatarTheme":id,"customAvatarTheme":custom,"useCustomAvatarTheme":true});
            let saved = put(&f, &path, false, value, revision).await;
            assert_eq!(saved.0, 200, "{id}: {}", saved.1);
            revision += 1;
            assert_eq!(saved.1["revision"], revision);
            assert_eq!(saved.1["theme"]["customAvatarTheme"]["motif"], id);
            assert_eq!(get(&f, &path, false).await, saved.1);
        }
    }
    assert_eq!(revision, 40);
    for id in [
        "grokbot-unknown",
        "open-avatar-unknown",
        "grokbot-../blob",
        "https://example.com/avatar.svg",
    ] {
        assert_eq!(put(&f, &path, false, builtin(id), revision).await.0, 400);
    }
    assert_eq!(get(&f, &path, false).await["revision"], revision);
    assert_eq!(get(&f, &path, true).await["revision"], 0);
    f.close().await;
}
async fn get(f: &Fixture, path: &str, member: bool) -> Value {
    let actor = if member { &f.member } else { &f.owner };
    let result = f.request("GET", path, None, member, Some(actor)).await;
    assert_eq!(result.0, 200, "{}", result.1);
    result.1
}
async fn put(f: &Fixture, path: &str, member: bool, theme: Value, revision: u64) -> (u16, Value) {
    let actor = if member { &f.member } else { &f.owner };
    f.request(
        "PUT",
        path,
        Some(json!({"theme":theme,"revision":revision})),
        member,
        Some(actor),
    )
    .await
}

#[tokio::test]
async fn member_preference_is_private_to_account_and_workspace_across_devices() {
    let f = Fixture::new().await;
    let path = f.path("/avatar-theme");
    assert_eq!(
        get(&f, &path, false).await,
        json!({"theme":null,"revision":0})
    );
    assert_eq!(
        get(&f, &path, true).await,
        json!({"theme":null,"revision":0})
    );
    let saved = put(&f, &path, true, builtin("pandas"), 0).await;
    assert_eq!(saved.0, 200);
    assert_eq!(saved.1, json!({"theme":builtin("pandas"),"revision":1}));
    assert_eq!(
        get(&f, &path, false).await,
        json!({"theme":null,"revision":0})
    );
    let foreign = format!("/api/workspaces/{}/avatar-theme", f.foreign);
    assert_eq!(
        get(&f, &foreign, true).await,
        json!({"theme":null,"revision":0})
    );
    assert_eq!(
        put(&f, &foreign, true, builtin("elephants"), 0).await.0,
        200
    );
    assert_eq!(get(&f, &path, true).await, saved.1);
    assert_eq!(
        get(&f, &foreign, true).await["theme"]["avatarTheme"],
        "elephants"
    );
    assert_eq!(
        f.request("GET", &foreign, None, false, Some(&f.owner))
            .await
            .0,
        403
    );
    // A second authenticated device sees this account's preference, not the team owner's.
    let token = "t".repeat(43);
    sqlx::query("INSERT INTO account_sessions VALUES(?,?,?,?, 'Second synthetic device',1,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(hex::encode(Sha256::digest(token.as_bytes())))
        .bind(&f.member)
        .bind("account")
        .bind(chrono::Utc::now().timestamp_millis() + 86_400_000)
        .execute(&f.db)
        .await
        .unwrap();
    let second = f
        .with_cookie(
            "GET",
            &path,
            None,
            &format!("openbot_account={token}"),
            Some(&f.member),
        )
        .await;
    assert_eq!(second, (200, saved.1));
    assert_eq!(
        f.request("GET", &path, None, true, Some(&f.owner)).await.0,
        403
    );
    assert_eq!(f.request("GET", &path, None, true, None).await.0, 403);
    assert_eq!(
        f.with_cookie("GET", &path, None, "", Some(&f.member))
            .await
            .0,
        401
    );
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.request("GET", &path, None, true, Some(&f.member)).await.0,
        403
    );
    assert_eq!(put(&f, &path, true, builtin("chicks"), 1).await.0, 403);
    f.close().await;
}

#[tokio::test]
async fn concurrent_writes_conflict_and_reset_preserves_revision_without_changing_bot_images() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let path = f.path("/avatar-theme");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut agent = initial["agents"][0].clone();
    agent["avatarImageId"] = json!("synthetic-user-upload-preserved");
    store.put(Table::Agents, &agent).await.unwrap();
    let (first, second) = tokio::join!(
        put(&f, &path, false, builtin("chicks"), 0),
        put(&f, &path, false, builtin("dinosaurs"), 0)
    );
    let (saved, conflict) = if first.0 == 200 {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(saved.0, 200);
    assert_eq!(conflict.0, 409);
    assert_eq!(conflict.1["code"], "AVATAR_THEME_CONFLICT");
    assert_eq!(get(&f, &path, false).await, saved.1);
    let reset = put(&f, &path, false, Value::Null, 1).await;
    assert_eq!(reset, (200, json!({"theme":null,"revision":2})));
    let stale = put(&f, &path, false, builtin("pandas"), 0).await;
    assert_eq!(stale.0, 409);
    assert_eq!(stale.1["code"], "AVATAR_THEME_CONFLICT");
    assert_eq!(get(&f, &path, false).await, reset.1);
    let restored = put(&f, &path, false, builtin("companions"), 2).await;
    assert_eq!(restored.0, 200);
    assert_eq!(restored.1["revision"], 3);
    assert_eq!(
        store
            .get(Table::Agents, agent["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap(),
        agent
    );
    f.close().await;
}

#[tokio::test]
async fn exact_structured_theme_validation_preserves_inactive_recipe_and_normalizes_colors() {
    let f = Fixture::new().await;
    let path = f.path("/avatar-theme");
    let mut cases = vec![
        json!({"revision":0}),
        json!({"theme":null}),
        json!({"theme":null,"revision":-1}),
        json!({"theme":null,"revision":0.5}),
        json!({"theme":null,"revision":9007199254740992u64}),
        json!({"theme":null,"revision":0,"userId":f.owner}),
        json!({"theme":{"avatarTheme":"custom","customAvatarTheme":null,"useCustomAvatarTheme":false},"revision":0}),
        json!({"theme":{"avatarTheme":"pandas","customAvatarTheme":null,"useCustomAvatarTheme":true},"revision":0}),
        json!({"theme":{"avatarTheme":"pandas","customAvatarTheme":null},"revision":0}),
        json!({"theme":{"avatarTheme":"pandas","customAvatarTheme":null,"useCustomAvatarTheme":false,"avatarImageId":"replace-upload"},"revision":0}),
    ];
    for (field, value) in [
        ("name", json!("https://assets.example.com/avatar.svg")),
        ("motif", json!("arbitrary")),
        ("colors", json!(["#AABBCC", "#aabbcc", "#ffffff"])),
        ("colors", json!(["#aabbcc", "#112233"])),
        ("badge", json!("<script>")),
        ("backdrop", json!("url(remote.png)")),
        ("assetUrl", json!("https://assets.example.com/avatar.png")),
    ] {
        let mut invalid = recipe();
        invalid[field] = value;
        cases.push(json!({"theme":{"avatarTheme":"pandas","customAvatarTheme":invalid,"useCustomAvatarTheme":true},"revision":0}));
    }
    for body in cases {
        let response = f
            .request("PUT", &path, Some(body.clone()), true, Some(&f.member))
            .await;
        assert_eq!(response.0, 400, "{body}: {}", response.1);
        assert_eq!(response.1["code"], "AVATAR_THEME_INVALID");
    }
    assert_eq!(
        get(&f, &path, true).await,
        json!({"theme":null,"revision":0})
    );
    let saved = put(
        &f,
        &path,
        true,
        json!({"avatarTheme":"chicks","customAvatarTheme":recipe(),"useCustomAvatarTheme":false}),
        0,
    )
    .await;
    assert_eq!(saved.0, 200, "{}", saved.1);
    assert_eq!(
        saved.1["theme"]["customAvatarTheme"]["name"],
        "Personal stars"
    );
    assert_eq!(
        saved.1["theme"]["customAvatarTheme"]["colors"],
        json!(["#aabbcc", "#112233", "#445566"])
    );
    assert_eq!(saved.1["theme"]["useCustomAvatarTheme"], false);
    let mut active = saved.1["theme"].clone();
    active["useCustomAvatarTheme"] = json!(true);
    assert_eq!(
        put(&f, &path, true, active.clone(), 1).await,
        (200, json!({"theme":active,"revision":2}))
    );
    f.close().await;
}

#[tokio::test]
async fn existing_sqlite_migrates_empty_then_restarts_with_account_theme_without_importing_device_state()
 {
    let mut f = Fixture::new().await;
    let before = f.bootstrap().await;
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,email,password_hash FROM users ORDER BY id")
            .fetch_all(&f.db)
            .await
            .unwrap();
    let cfg = f.state.config.clone();
    f.state.close().await;
    // Remove only the new empty table to reproduce an existing pre-feature identity database.
    sqlx::query("DROP TABLE account_workspace_avatar_themes")
        .execute(&f.db)
        .await
        .unwrap();
    f.state = State::open((*cfg).clone()).await.unwrap();
    let path = f.path("/avatar-theme");
    assert_eq!(
        get(&f, &path, false).await,
        json!({"theme":null,"revision":0})
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM account_workspace_avatar_themes")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "GET must not migrate or invent a device preference"
    );
    assert_eq!(f.bootstrap().await["agents"], before["agents"]);
    let after: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id,email,password_hash FROM users ORDER BY id")
            .fetch_all(&f.db)
            .await
            .unwrap();
    assert_eq!(rows, after);
    let saved = put(&f, &path, false, builtin("elephants"), 0).await;
    assert_eq!(saved.0, 200);
    f.state.close().await;
    f.state = State::open((*cfg).clone()).await.unwrap();
    assert_eq!(get(&f, &path, false).await, saved.1);
    assert_eq!(
        get(&f, &path, true).await,
        json!({"theme":null,"revision":0})
    );
    f.close().await;
}
