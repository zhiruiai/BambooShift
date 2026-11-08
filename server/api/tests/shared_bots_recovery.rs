mod shared_bots_support;
use openbot_backend::{config::Config, db::State, workspace::Table};
use serde_json::json;
use sha2::{Digest, Sha256};
use shared_bots_support::*;

#[tokio::test]
async fn old_node_receipt_digest_replays_current_canonical_policy_without_rotating_access() {
    let mut s = Shared::new().await;
    let request = id();
    let expected = s.share["revision"].clone();
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&json!([
            "update",
            s.f.workspace,
            s.agent,
            expected,
            s.f.workspace,
            "team",
            []
        ]))
        .unwrap(),
    ));
    let central = sqlx::SqlitePool::connect(&format!(
        "sqlite:{}",
        s.f.directory
            .path()
            .join("platform/shared-bots.sqlite")
            .display()
    ))
    .await
    .unwrap();
    sqlx::query("INSERT INTO shared_bot_mutations VALUES(?,?,?,?)")
        .bind(&s.f.owner)
        .bind(&request)
        .bind(digest)
        .bind(s.share["id"].as_str().unwrap())
        .execute(&central)
        .await
        .unwrap();
    let body = json!({"requestId":request,"expectedRevision":expected,"targetTeamId":s.f.workspace,"audience":"team","memberIds":[]});
    let (status, replay) =
        s.f.request(
            "PUT",
            &s.sharing(),
            Some(body.clone()),
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay["share"], s.share);
    let access = s.share["accessRevision"].clone();
    s.update(json!({})).await;
    assert_eq!(
        s.share["accessRevision"], access,
        "ordinary no-op configuration cannot interrupt current root"
    );
    let (status, latest) =
        s.f.request("PUT", &s.sharing(), Some(body), false, Some(&s.f.owner))
            .await;
    assert_eq!(status, 200, "{latest}");
    assert_eq!(latest["share"], s.share);
    central.close().await;
    s.close().await;
}
#[tokio::test]
async fn failed_personal_dm_insert_rolls_back_alias_reference_and_receipt_and_can_retry() {
    let s = Shared::new().await;
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let before = target.list(Table::Agents).await.unwrap();
    sqlx::query("CREATE TRIGGER refuse_alias_dm BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&target.pool).await.unwrap();
    let body = json!({"requestId":id(),"shareId":s.share["id"]});
    let (status, _) =
        s.f.request(
            "POST",
            &s.ref_path(),
            Some(body.clone()),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(status, 500);
    assert_eq!(target.list(Table::Agents).await.unwrap(), before);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM shared_bot_refs")
        .fetch_one(&target.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM shared_bot_add_receipts")
        .fetch_one(&target.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("DROP TRIGGER refuse_alias_dm")
        .execute(&target.pool)
        .await
        .unwrap();
    let (status, result) =
        s.f.request("POST", &s.ref_path(), Some(body), true, Some(&s.f.member))
            .await;
    assert_eq!(status, 201, "{result}");
    s.close().await;
}
#[tokio::test]
async fn persistent_reference_survives_server_restart_without_copying_or_reassigning_identities() {
    let mut s = Shared::new().await;
    let receipt = s.add().await;
    let store =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    store.put(Table::Messages,&json!({"id":id(),"conversationId":receipt["conversationId"],"role":"user","content":"recipient private history"})).await.unwrap();
    s.f.state.close().await;
    s.f.state = State::open(Config::local(s.f.directory.path()))
        .await
        .unwrap();
    let next = s.add().await;
    assert_eq!(next["agentId"], receipt["agentId"]);
    assert_eq!(next["conversationId"], receipt["conversationId"]);
    let resolved = resolve(&s, &next).await;
    assert_eq!(resolved.agent["id"], receipt["agentId"]);
    let (_, snapshot) =
        s.f.request(
            "GET",
            &format!("/api/workspaces/{}/bootstrap", s.personal),
            None,
            true,
            Some(&s.f.member),
        )
        .await;
    assert!(
        snapshot["messages"]
            .to_string()
            .contains("recipient private history")
    );
    s.close().await;
}
#[tokio::test]
async fn approved_source_app_handle_attaches_existing_store_without_seed_recovery_or_key_migration()
{
    let mut s = Shared::new().await;
    let receipt = s.add().await;
    let app = id();
    let row = json!({"id":app,"name":"Source App","url":"https://source.example.test/mcp","authType":"bearer","token":"SOURCE_ONLY_LEGACY_KEY","status":"connected","revision":id(),"tools":[],"createdAt":"2026-01-01T00:00:00.000Z"});
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_connections(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    )
    .execute(&s.source.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO app_connections VALUES(?,?)")
        .bind(&app)
        .bind(row.to_string())
        .execute(&s.source.pool)
        .await
        .unwrap();
    let input = id();
    s.source.put(Table::Messages,&json!({"id":input,"role":"user","content":"source queue","delivery":{"state":"queued"}})).await.unwrap();
    let mut agent = s
        .source
        .get(Table::Agents, &s.agent)
        .await
        .unwrap()
        .unwrap();
    agent["status"] = json!("working");
    s.source.put(Table::Agents, &agent).await.unwrap();
    s.f.state.close().await;
    s.f.state = State::open(Config::local(s.f.directory.path()))
        .await
        .unwrap();
    let resolved = resolve(&s, &receipt).await;
    let attached = resolved.grant.app_source_store(&s.f.state).await.unwrap();
    assert_eq!(
        attached
            .get(Table::Agents, &s.agent)
            .await
            .unwrap()
            .unwrap()["status"],
        "working"
    );
    assert_eq!(
        attached
            .get(Table::Messages, &input)
            .await
            .unwrap()
            .unwrap()["delivery"]["state"],
        "queued"
    );
    let stored: String = sqlx::query_scalar("SELECT data FROM app_connections WHERE id=?")
        .bind(&app)
        .fetch_one(&attached.pool)
        .await
        .unwrap();
    assert_eq!(
        stored,
        row.to_string(),
        "attaching must not migrate credentials or refresh tokens"
    );
    assert!(
        !s.f.directory
            .path()
            .join("spaces")
            .join(&s.personal)
            .join("config/apps.private.json")
            .exists()
    );
    let normal =
        s.f.state
            .workspace
            .get(&s.f.workspace, &s.f.workspace)
            .await
            .unwrap();
    assert!(std::sync::Arc::ptr_eq(&normal, &attached));
    assert_eq!(
        normal.get(Table::Agents, &s.agent).await.unwrap().unwrap()["status"],
        "idle"
    );
    assert_eq!(
        normal.get(Table::Messages, &input).await.unwrap().unwrap()["delivery"]["state"],
        "interrupted"
    );
    s.close().await;
}
