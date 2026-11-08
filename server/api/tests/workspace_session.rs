mod workspace_support;
use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn workspace_auth_status_requires_real_account_membership_without_opening_business_storage() {
    let f = Fixture::new().await;
    for (member, user) in [(false, &f.owner), (true, &f.member)] {
        let (status, value) = f
            .request("GET", &f.path("/auth/status"), None, member, Some(user))
            .await;
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["mode"], "account");
        assert_eq!(value["paired"], true);
    }
    assert!(!f.directory.path().join("spaces").exists());
    let (status, _) = f
        .with_cookie("GET", &f.path("/auth/status"), None, "", None)
        .await;
    assert_eq!(status, 401);
    let (status, _) = f
        .with_cookie(
            "GET",
            &f.path("/auth/status"),
            None,
            &format!("openbot_operator={}", f.operator_token),
            None,
        )
        .await;
    assert_eq!(status, 401);
    let (status, _) = f
        .request("GET", &f.path("/auth/status"), None, true, Some(&f.owner))
        .await;
    assert_eq!(status, 403);
    let (status, _) = f
        .request(
            "GET",
            &format!("/api/workspaces/{}/auth/status", f.foreign),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 403);
    let (status, _) = f
        .request(
            "POST",
            &f.path("/auth/pair"),
            Some(json!({"code":"untrusted"})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 404);
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    let (status, _) = f
        .request("GET", &f.path("/auth/status"), None, true, Some(&f.member))
        .await;
    assert_eq!(status, 401);
    assert!(!f.directory.path().join("spaces").exists());
    f.close().await;
}
