mod shared_bots_support;
use openbot_backend::{shared_bots, workspace::Table};
use serde_json::json;
use shared_bots_support::*;

#[tokio::test]
async fn source_profile_and_active_skills_are_live_but_each_run_keeps_its_snapshot() {
    let s = Shared::new().await;
    let receipt = s.add().await;
    let alias = receipt["agentId"].as_str().unwrap();
    let created = "2026-01-01T00:00:00.000Z";
    s.source.put(Table::Skills,&json!({"id":id(),"agentId":s.agent,"name":"Source Method","description":"Published skill","content":"SOURCE_ACTIVE_RULE","version":1,"status":"active","createdAt":created})).await.unwrap();
    s.source.put(Table::Skills,&json!({"id":id(),"agentId":s.agent,"name":"Unapproved","description":"Private draft","content":"DRAFT_NOT_SHARED","version":1,"status":"proposed","createdAt":created})).await.unwrap();
    s.source
        .put(
            Table::Memories,
            &json!({"id":id(),"agentId":s.agent,"content":"SOURCE_PRIVATE_MEMORY"}),
        )
        .await
        .unwrap();
    let first = resolve(&s, &receipt).await;
    assert_eq!(first.agent["id"], alias);
    assert_eq!(first.skills.len(), 1);
    assert!(
        serde_json::to_string(&first.skills)
            .unwrap()
            .contains("SOURCE_ACTIVE_RULE")
    );
    let raw_target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let before = raw_target.get(Table::Agents, alias).await.unwrap().unwrap();
    let mut source = s
        .source
        .get(Table::Agents, &s.agent)
        .await
        .unwrap()
        .unwrap();
    source["name"] = json!("Updated Source");
    source["instructions"] = json!("NEW_INSTRUCTIONS");
    source["configRevision"] = json!(id());
    s.source.put(Table::Agents, &source).await.unwrap();
    first.grant.authorize(&s.f.state).await.unwrap();
    assert_ne!(first.agent["name"], source["name"]);
    let second = resolve(&s, &receipt).await;
    assert_eq!(second.agent["name"], source["name"]);
    assert_ne!(
        second.agent["sharedBot"]["sourceRevision"],
        first.agent["sharedBot"]["sourceRevision"]
    );
    assert_eq!(
        raw_target.get(Table::Agents, alias).await.unwrap().unwrap(),
        before,
        "projection must not overwrite raw local cache"
    );
    assert!(raw_target.list(Table::Memories).await.unwrap().is_empty());
    assert!(raw_target.list(Table::Skills).await.unwrap().is_empty());
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
        snapshot["skills"]
            .to_string()
            .contains("SOURCE_ACTIVE_RULE")
    );
    assert!(!snapshot.to_string().contains("SOURCE_PRIVATE_MEMORY"));
    assert!(!snapshot.to_string().contains("DRAFT_NOT_SHARED"));
    s.close().await;
}
#[tokio::test]
async fn grant_rechecks_member_source_owner_alias_and_access_epoch_without_local_fallback() {
    let mut s = Shared::new().await;
    let receipt = s.add().await;
    let grant = resolve(&s, &receipt).await.grant;
    s.update(json!({"audience":"selected","memberIds":[s.f.member]}))
        .await;
    assert_eq!(grant.authorize(&s.f.state).await.unwrap_err().status, 403);
    let current = resolve(&s, &receipt).await.grant;
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&s.f.workspace)
        .bind(&s.f.member)
        .execute(&s.f.db)
        .await
        .unwrap();
    assert_eq!(current.authorize(&s.f.state).await.unwrap_err().status, 403);
    sqlx::query("INSERT INTO memberships VALUES(?,?,'member',1)")
        .bind(&s.f.workspace)
        .bind(&s.f.member)
        .execute(&s.f.db)
        .await
        .unwrap();
    let current = resolve(&s, &receipt).await.grant;
    sqlx::query("UPDATE users SET status='suspended' WHERE id=?")
        .bind(&s.f.owner)
        .execute(&s.f.db)
        .await
        .unwrap();
    assert_eq!(current.authorize(&s.f.state).await.unwrap_err().status, 403);
    sqlx::query("UPDATE users SET status='active' WHERE id=?")
        .bind(&s.f.owner)
        .execute(&s.f.db)
        .await
        .unwrap();
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let mut agent = target
        .get(Table::Agents, receipt["agentId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    agent["sharedBot"] = json!({});
    target.put(Table::Agents, &agent).await.unwrap();
    assert!(
        shared_bots::resolve(&s.f.state, &s.access().await, agent["id"].as_str().unwrap())
            .await
            .is_err()
    );
    assert_eq!(current.authorize(&s.f.state).await.unwrap_err().status, 403);
    s.close().await;
}
#[tokio::test]
async fn readonly_source_rejects_replaced_database_and_never_reinitializes_deleted_source() {
    use std::os::unix::fs::symlink;
    let s = Shared::new().await;
    let receipt = s.add().await;
    let resolved = resolve(&s, &receipt).await;
    let db = s.source.directory.join("openbot.sqlite");
    let moved = s.source.directory.join("moved.sqlite");
    std::fs::rename(&db, &moved).unwrap();
    symlink(&moved, &db).unwrap();
    assert!(resolved.grant.authorize(&s.f.state).await.is_err());
    let (_, snapshot) =
        s.f.request(
            "GET",
            &format!("/api/workspaces/{}/bootstrap", s.personal),
            None,
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(
        snapshot["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == receipt["agentId"])
            .unwrap()["sharedBot"]["status"],
        "unavailable"
    );
    std::fs::remove_file(&db).unwrap();
    assert!(
        shared_bots::resolve(
            &s.f.state,
            &s.access().await,
            receipt["agentId"].as_str().unwrap()
        )
        .await
        .is_err()
    );
    assert!(!db.exists());
    std::fs::rename(&moved, &db).unwrap();
    s.close().await;
}
