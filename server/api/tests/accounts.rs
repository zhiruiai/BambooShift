mod common;
use common::{Fixture, request};
use serde_json::json;

#[tokio::test]
async fn registration_login_and_restart_preserve_personal_and_team_contracts() {
    let f = Fixture::new().await;
    let registered = f.register("OWNER@EXAMPLE.TEST", true).await;
    let cookie = registered.cookie();
    assert_eq!(registered.value["workspaces"].as_array().unwrap().len(), 2);
    assert_eq!(registered.value["user"]["email"], "owner@example.test");
    assert_eq!(
        registered.value["workspaces"][1]["id"],
        registered.value["workspaceId"]
    );
    assert_eq!(registered.value["workspaces"][0]["role"], "owner");
    assert!(!registered.value.to_string().contains("password"));
    assert!(
        registered.headers["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly; SameSite=Strict")
    );
    assert_eq!(
        f.request("GET", "/api/account/session", &cookie, None)
            .await
            .value["user"],
        registered.value["user"]
    );
    let anonymous = f.request("GET", "/api/account/session", "", None).await;
    assert_eq!(
        anonymous.value,
        json!({"authenticated":false,"workspaces":[]})
    );
    let duplicate = f.register("peer@example.test", false).await;
    assert_eq!(duplicate.value["workspaces"].as_array().unwrap().len(), 1);
    f.state.close().await;
    let state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        f.directory.path(),
    ))
    .await
    .unwrap();
    let app = openbot_backend::router(state.clone());
    assert_eq!(
        request(&app, "GET", "/api/account/session", &cookie, None, &[])
            .await
            .value["authenticated"],
        true
    );
    let login = request(
        &app,
        "POST",
        "/api/account/login",
        &cookie,
        Some(json!({"email":"owner@example.test","password":"fixture-password-42"})),
        &[],
    )
    .await;
    assert_eq!(login.status, 200);
    assert_ne!(login.cookie(), cookie);
    assert_eq!(
        request(&app, "GET", "/api/account/session", &cookie, None, &[])
            .await
            .value["authenticated"],
        false
    );
    state.close().await;
}

#[tokio::test]
async fn account_mutations_require_original_actor_and_password_revokes_sessions() {
    let f = Fixture::new().await;
    let a = f.register("a@example.test", false).await;
    let b = f.register("b@example.test", false).await;
    let a_id = a.value["user"]["id"].as_str().unwrap();
    let b_cookie = b.cookie();
    let denied = f
        .request(
            "PATCH",
            "/api/account/profile",
            &b_cookie,
            Some(json!({"name":"wrong","expectedUserId":a_id})),
        )
        .await;
    assert_eq!(denied.status, 409);
    assert_eq!(
        request(
            &f.app,
            "GET",
            "/api/account/sessions",
            &b_cookie,
            None,
            &[("x-openbot-expected-user", a_id)]
        )
        .await
        .status,
        403
    );
    let changed = f
        .request(
            "PATCH",
            "/api/account/profile",
            &a.cookie(),
            Some(json!({"name":"新名字","expectedUserId":a_id})),
        )
        .await;
    assert_eq!(changed.value["user"]["name"], "新名字");
    let db = f.database().await;
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM account_sessions")
        .fetch_one(&db)
        .await
        .unwrap();
    let wrong=f.request("POST","/api/account/password",&a.cookie(),Some(json!({"expectedUserId":a_id,"currentPassword":"wrong","newPassword":"new-password-42"}))).await;
    assert_eq!(wrong.status, 400);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM account_sessions")
            .fetch_one(&db)
            .await
            .unwrap(),
        before
    );
    let changed=f.request("POST","/api/account/password",&a.cookie(),Some(json!({"expectedUserId":a_id,"currentPassword":"fixture-password-42","newPassword":"new-password-42"}))).await;
    assert_eq!(changed.status, 204);
    assert_eq!(
        f.request("GET", "/api/account/session", &a.cookie(), None)
            .await
            .value["authenticated"],
        false
    );
    assert_eq!(
        f.request("GET", "/api/account/session", &b.cookie(), None)
            .await
            .value["authenticated"],
        true
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/account/login",
            "",
            Some(json!({"email":"a@example.test","password":"new-password-42"}))
        )
        .await
        .status,
        200
    );
    db.close().await;
    f.state.close().await;
}

#[tokio::test]
async fn duplicate_email_is_atomic_and_session_revoke_does_not_cross_accounts() {
    let f = Fixture::new().await;
    let payload = json!({"email":"same@example.test","name":"同名","password":"fixture-password-42","kind":"personal"});
    let (a, b) = tokio::join!(
        f.request("POST", "/api/account/register", "", Some(payload.clone())),
        f.request("POST", "/api/account/register", "", Some(payload))
    );
    let mut statuses = vec![a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, vec![201, 409]);
    let user = if a.status == 201 { a } else { b };
    let peer = f.register("peer@example.test", false).await;
    let sessions = f
        .request("GET", "/api/account/sessions", &peer.cookie(), None)
        .await;
    let peer_session = sessions.value["sessions"][0]["id"].as_str().unwrap();
    let response = f
        .request(
            "DELETE",
            &format!("/api/account/sessions/{peer_session}"),
            &user.cookie(),
            Some(json!({"expectedUserId":user.value["user"]["id"]})),
        )
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(
        f.request("GET", "/api/account/session", &peer.cookie(), None)
            .await
            .value["authenticated"],
        true
    );
    let db = f.database().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
            .fetch_one(&db)
            .await
            .unwrap(),
        2
    );
    db.close().await;
    f.state.close().await;
}
