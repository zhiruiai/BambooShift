mod common;
use common::Fixture;
use serde_json::json;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn existing_node_scrypt_and_session_rows_work_without_rewriting_data() {
    let f = Fixture::new().await;
    let db = f.database().await;
    let uid = "f3e359d1-26b3-4d43-80e0-67ff6ba86179";
    let wid = "341a1648-eb56-4559-b586-f8d253029116";
    // This deterministic hash was produced by Node crypto.scryptSync with the existing application parameters.
    let hash = "scrypt-v1:0123456789abcdef0123456789abcdef0123456789abcdef:450c4754d98d22f95241d7c115a3b4391a9a327c01faa9166080600eb4190ee9";
    sqlx::query("INSERT INTO users VALUES(?,?,'Existing',?,'active','user',?)")
        .bind(uid)
        .bind("existing@example.test")
        .bind(hash)
        .bind(1_700_000_000_000i64)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces VALUES(?,'Legacy','personal','active','legacy',?)")
        .bind(wid)
        .bind(1_700_000_000_000i64)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',?)")
        .bind(wid)
        .bind(uid)
        .bind(1_700_000_000_000i64)
        .execute(&db)
        .await
        .unwrap();
    let raw = "A".repeat(43);
    let token_hash = hex::encode(Sha256::digest(raw.as_bytes()));
    sqlx::query(
        "INSERT INTO account_sessions VALUES('existing-session',?,?,'account','Node browser',?,?)",
    )
    .bind(token_hash)
    .bind(uid)
    .bind(1_700_000_000_000i64)
    .bind(4_000_000_000_000i64)
    .execute(&db)
    .await
    .unwrap();
    let old = f
        .request(
            "GET",
            "/api/account/session",
            &format!("openbot_account={raw}"),
            None,
        )
        .await;
    assert_eq!(old.value["user"]["id"], uid);
    assert_eq!(old.value["workspaces"][0]["id"], wid);
    assert_eq!(old.value["user"]["createdAt"], "2023-11-14T22:13:20.000Z");
    let login = f
        .request(
            "POST",
            "/api/account/login",
            "",
            Some(json!({"email":"existing@example.test","password":"fixture-password-42"})),
        )
        .await;
    assert_eq!(login.status, 200, "{}", login.value);
    assert_eq!(login.value["workspaceId"], wid);
    let actual: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
        .bind(uid)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(actual, hash);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT storage_key FROM workspaces WHERE id=?")
            .bind(wid)
            .fetch_one(&db)
            .await
            .unwrap(),
        "legacy"
    );
    db.close().await;
    f.state.close().await;
}

#[tokio::test]
async fn operator_setup_claims_existing_unowned_legacy_without_duplicate_workspace() {
    let f = Fixture::new().await;
    let db = f.database().await;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO workspaces VALUES(?,'Existing personal','personal','active','legacy',0)",
    )
    .bind(&id)
    .execute(&db)
    .await
    .unwrap();
    let operator = f.admin().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workspaces")
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    let owner: String =
        sqlx::query_scalar("SELECT user_id FROM memberships WHERE workspace_id=? AND role='owner'")
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(owner, operator.value["user"]["id"].as_str().unwrap());
    db.close().await;
    f.state.close().await;
}
