mod apps_support;
mod workspace_support;
use apps_support::*;
use openbot_backend::{apps, config::Config, db::State};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use workspace_support::Fixture;

#[tokio::test]
async fn legacy_secrets_move_to_private_file_without_changing_tool_schema_order() {
    let mut f = Fixture::new().await;
    let data = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let cid = uuid::Uuid::new_v4().to_string();
    let revision = uuid::Uuid::new_v4().to_string();
    let tool = r#"{"name":"write_note","description":"Legacy","inputSchema":{"type":"object","properties":{"z":{"type":"string"},"a":{"type":"number"}}}}"#;
    let raw = format!(
        r#"{{"id":"{cid}","name":"Legacy","url":"https://example.test/mcp","revision":"{revision}","authType":"bearer","status":"connected","token":"synthetic-legacy-secret","tools":[{tool}],"createdAt":"2026-01-01T00:00:00Z"}}"#
    );
    sqlx::query("INSERT INTO app_connections VALUES(?,?)")
        .bind(&cid)
        .bind(raw)
        .execute(&store.pool)
        .await
        .unwrap();
    let chat = &data["conversations"][0];
    let action = uuid::Uuid::new_v4().to_string();
    let saved = json!({"action":{"id":action,"agentId":chat["agentIds"][0],"conversationId":chat["id"],"connectionId":cid,"status":"running","createdAt":"2026-01-01T00:00:00Z"},"cardId":uuid::Uuid::new_v4().to_string(),"runId":"synthetic"});
    sqlx::query("INSERT INTO app_actions VALUES(?,?)")
        .bind(&action)
        .bind(saved.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    let data = f.bootstrap().await;
    assert_eq!(data["apps"][0]["revision"], revision);
    assert!(data["apps"][0]["hasCredential"] == true);
    assert!(!data.to_string().contains("synthetic-legacy-secret"));
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM app_connections WHERE id=?")
        .bind(&cid)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert!(!raw.contains("synthetic-legacy-secret"));
    let schema: String = sqlx::query_scalar(
        "SELECT json_extract(data,'$.tools[0].inputSchema') FROM app_connections WHERE id=?",
    )
    .bind(&cid)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(schema.find("\"z\"").unwrap() < schema.find("\"a\"").unwrap());
    let prepared = apps::connections::prepare_call(&store, &cid, "write_note", &json!({}))
        .await
        .unwrap();
    let tool: Value = serde_json::from_str(tool).unwrap();
    assert_eq!(
        prepared.schema_hash,
        openbot_backend::shared_bots::tool_revision_with_schema(&tool, &schema).unwrap()
    );
    let action = apps::actions::get(&store, &action).await.unwrap();
    assert_eq!(action["status"], "error");
    assert!(action["error"].as_str().unwrap().contains("结果未知"));
    f.close().await;
}
#[tokio::test]
async fn a_server_requiring_credentials_can_upgrade_none_to_bearer_and_refresh_catalog() {
    let server = Server::start().await;
    server.remote.bearer.store(true, Ordering::SeqCst);
    let mut f = Fixture::new().await;
    f.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    let(status,c)=f.request("POST",&f.path("/apps"),Some(json!({"name":"Upgrade","url":format!("{}/mcp",server.remote.origin),"authType":"none","shared":true})),false,Some(&f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(c["status"], "needs_auth");
    let (status, connected) = f
        .request(
            "POST",
            &f.path(&format!("/apps/{}/reconnect", c["id"].as_str().unwrap())),
            Some(json!({"token":"synthetic-access"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{connected}");
    assert_eq!(connected["status"], "connected");
    assert_eq!(connected["authType"], "bearer");
    assert_ne!(connected["revision"], c["revision"]);
    f.close().await;
}
#[tokio::test]
async fn local_fixture_still_rejects_redirects_and_oversized_protocol_responses() {
    let server = Server::start().await;
    let mut f = Fixture::new().await;
    f.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    for path in ["redirect", "huge"] {
        let(status,c)=f.request("POST",&f.path("/apps"),Some(json!({"name":path,"url":format!("{}/{path}",server.remote.origin),"authType":"none","shared":true})),false,Some(&f.owner)).await;
        assert_eq!(status, 200);
        assert_eq!(c["status"], "error");
        assert_eq!(c["toolCount"], 0);
        assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    }
    f.close().await;
}
