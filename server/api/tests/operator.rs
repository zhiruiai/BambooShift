mod common;
use common::Fixture;
use serde_json::json;

#[tokio::test]
async fn operator_and_product_sessions_are_independent_and_suspend_revokes_access() {
    let f = Fixture::new().await;
    let admin = f.admin().await;
    let user = f.register("user@example.test", true).await;
    assert!(admin.cookie().starts_with("openbot_operator="));
    assert_eq!(
        f.request("GET", "/api/account/session", &admin.cookie(), None)
            .await
            .value["authenticated"],
        false
    );
    assert_eq!(
        f.request("GET", "/api/platform/users", &user.cookie(), None)
            .await
            .status,
        401
    );
    let login = f
        .request(
            "POST",
            "/api/account/login",
            &admin.cookie(),
            Some(json!({"email":"admin@example.test","password":"fixture-password-42"})),
        )
        .await;
    assert_eq!(login.status, 200);
    let both = format!("{}; {}", admin.cookie(), login.cookie());
    assert_eq!(
        f.request("GET", "/api/platform/session", &both, None)
            .await
            .value["authenticated"],
        true
    );
    assert_eq!(
        f.request("GET", "/api/account/session", &both, None)
            .await
            .value["authenticated"],
        true
    );
    assert_eq!(
        f.request("GET", "/api/platform/users", &login.cookie(), None)
            .await
            .status,
        401
    );
    let user_id = user.value["user"]["id"].as_str().unwrap();
    let space = user.value["workspaceId"].as_str().unwrap();
    let mut changes = f.state.subscribe_security();
    assert_eq!(
        f.request(
            "PATCH",
            &format!("/api/platform/users/{user_id}"),
            &admin.cookie(),
            Some(json!({"status":"suspended"}))
        )
        .await
        .status,
        200
    );
    assert_eq!(
        changes.recv().await.unwrap().user_id.as_deref(),
        Some(user_id)
    );
    assert_eq!(
        f.request("GET", "/api/account/session", &user.cookie(), None)
            .await
            .value["authenticated"],
        false
    );
    let overview = f
        .request("GET", "/api/platform/overview", &admin.cookie(), None)
        .await;
    assert_eq!(overview.value["counts"]["suspendedUsers"], 1);
    assert_eq!(overview.value["counts"]["users"], 2);
    assert_eq!(
        f.request(
            "PATCH",
            &format!("/api/platform/workspaces/{space}"),
            &admin.cookie(),
            Some(json!({"status":"suspended"}))
        )
        .await
        .status,
        200
    );
    let listing = f
        .request("GET", "/api/platform/workspaces", &admin.cookie(), None)
        .await;
    assert!(listing.value.to_string().contains("memberCount"));
    assert!(!listing.value.to_string().contains("storage_key"));
    assert_eq!(
        f.request("POST", "/api/account/logout", &both, None)
            .await
            .status,
        200
    );
    assert_eq!(
        f.request("GET", "/api/platform/session", &admin.cookie(), None)
            .await
            .value["authenticated"],
        true
    );
    assert_eq!(
        f.request("POST", "/api/platform/logout", &admin.cookie(), None)
            .await
            .status,
        200
    );
    assert_eq!(
        f.request("GET", "/api/platform/users", &admin.cookie(), None)
            .await
            .status,
        401
    );
    f.state.close().await;
}

#[tokio::test]
async fn setup_is_one_time_and_administrators_cannot_be_suspended() {
    let f = Fixture::new().await;
    let initial = f.request("GET", "/api/platform/session", "", None).await;
    assert_eq!(
        initial.value,
        json!({"authenticated":false,"setupRequired":true})
    );
    let path = f.state.provision_operator().await.unwrap();
    let code = std::fs::read_to_string(&path).unwrap();
    assert_eq!(f.state.provision_operator().await.unwrap(), path);
    let admin = f.admin().await;
    assert!(!path.exists());
    assert_eq!(f.request("POST","/api/platform/setup","",Some(json!({"code":code.trim(),"email":"another@example.test","name":"another","password":"fixture-password-42"}))).await.status,403);
    let id = admin.value["user"]["id"].as_str().unwrap();
    assert_eq!(
        f.request(
            "PATCH",
            &format!("/api/platform/users/{id}"),
            &admin.cookie(),
            Some(json!({"status":"suspended"}))
        )
        .await
        .status,
        409
    );
    assert_eq!(
        f.request("GET", "/api/platform/users?q=%25", &admin.cookie(), None)
            .await
            .value["total"],
        0
    );
    assert_eq!(
        f.request("GET", "/api/platform/users?page=0", &admin.cookie(), None)
            .await
            .status,
        400
    );
    assert_eq!(
        f.request("GET", "/api/platform/users?page=1", &admin.cookie(), None)
            .await
            .value["pageSize"],
        50
    );
    f.state.close().await;
}
