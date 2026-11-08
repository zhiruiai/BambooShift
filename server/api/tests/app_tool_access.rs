mod apps_support;
mod workspace_support;

use apps_support::{Server, headers, wait_until};
use openbot_backend::{
    apps::{self, actions, connections},
    workspace::{WorkspaceStore, access},
};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use workspace_support::Fixture;

const TARGET: &str = "write_note";
const SIBLING: &str = "read_notes";

async fn setup() -> (Fixture, Server, Value, Arc<WorkspaceStore>) {
    let server = Server::start().await;
    *server.remote.catalog.lock().await = Some(vec![
        json!({"name":TARGET,"description":"Write a synthetic note","inputSchema":{"type":"object"},
            "access":{"enabled":false,"revision":"untrusted-provider-value"}}),
        json!({"name":SIBLING,"description":"Read synthetic notes","inputSchema":{"type":"object"}}),
    ]);
    let mut fixture = Fixture::new().await;
    fixture.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    let (status, connection) = fixture
        .request(
            "POST",
            &fixture.path("/apps"),
            Some(json!({
                "name":"App permission fixture", "url":format!("{}/mcp", server.remote.origin),
                "authType":"none", "shared":true,
            })),
            false,
            Some(&fixture.owner),
        )
        .await;
    assert_eq!(status, 200, "{connection}");
    assert_eq!(connection["status"], "connected", "{connection}");
    let store = fixture
        .state
        .workspace
        .get(&fixture.workspace, &fixture.workspace)
        .await
        .unwrap();
    (fixture, server, connection, store)
}

fn tool<'a>(tools: &'a Value, name: &str) -> &'a Value {
    tools
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == name)
        .unwrap()
}

async fn catalog(f: &Fixture, c: &Value, member: bool) -> Value {
    let id = c["id"].as_str().unwrap();
    let (status, value) = f
        .request(
            "GET",
            &f.path(&format!("/apps/{id}/tools")),
            None,
            member,
            Some(if member { &f.member } else { &f.owner }),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value
}

async fn toggle(f: &Fixture, c: &Value, tool: &Value, enabled: bool, member: bool) -> (u16, Value) {
    let id = c["id"].as_str().unwrap();
    f.request(
        "PUT",
        &f.path(&format!("/apps/{id}/tools/access")),
        Some(json!({
            "toolName":tool["name"], "enabled":enabled, "expectedConnectionRevision":c["revision"],
            "expectedToolRevision":tool["access"]["revision"],
        })),
        member,
        Some(if member { &f.member } else { &f.owner }),
    )
    .await
}

async fn set_target(f: &Fixture, c: &Value, enabled: bool) -> Value {
    let tools = catalog(f, c, false).await;
    let (status, saved) = toggle(f, c, tool(&tools, TARGET), enabled, false).await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["access"]["enabled"], enabled);
    saved
}

async fn prepare_action(f: &Fixture, store: &Arc<WorkspaceStore>, c: &Value, name: &str) -> Value {
    let data = f.bootstrap().await;
    let chat = data["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["isGroup"] != true)
        .unwrap();
    let actor = access::require(
        &f.state,
        &headers(&f.member_token, &f.member),
        &f.workspace,
        false,
        true,
    )
    .await
    .unwrap();
    let prepared = connections::prepare_call(
        store,
        c["id"].as_str().unwrap(),
        name,
        &json!({"text":"synthetic result"}),
    )
    .await
    .unwrap();
    actions::request(
        &f.state,
        store.clone(),
        store.clone(),
        actions::ActionContext {
            conversation_id: chat["id"].as_str().unwrap().into(),
            thread_root_id: None,
            agent_id: chat["agentIds"][0].as_str().unwrap().into(),
            run_id: uuid::Uuid::new_v4().to_string(),
            requester: Some(json!({"userId":f.member,"name":"Synthetic member"})),
            source: None,
        },
        prepared,
        apps::user_authority(&f.state, &actor),
    )
    .await
    .unwrap()
}

async fn approve(f: &Fixture, action: &Value) -> (u16, Value) {
    let id = action["id"].as_str().unwrap();
    f.request(
        "POST",
        &f.path(&format!("/app-actions/{id}/decision")),
        Some(json!({"approve":true})),
        true,
        Some(&f.member),
    )
    .await
}

async fn settled(store: &WorkspaceStore, action: &Value) -> Value {
    let id = action["id"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let current = actions::get(store, id).await.unwrap();
            if actions::terminal(&current) {
                return current;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("App action did not settle")
}

#[tokio::test]
async fn owner_updates_one_tool_and_old_revisions_cannot_return_after_reconnect() {
    let (f, _server, c, store) = setup().await;
    let id = c["id"].as_str().unwrap();
    assert_eq!(c["toolAccessSupported"], true);
    assert!(c.get("toolControls").is_none());
    let original = catalog(&f, &c, true).await;
    let initial = tool(&original, TARGET);
    assert_eq!(initial["access"]["enabled"], true);
    assert_ne!(initial["access"]["revision"], "untrusted-provider-value");
    assert_eq!(toggle(&f, &c, initial, false, true).await.0, 403);
    assert_eq!(
        toggle(&f, &c, initial, true, false).await,
        (200, initial.clone())
    );
    let disabled = set_target(&f, &c, false).await;
    assert_ne!(
        disabled["access"]["revision"],
        initial["access"]["revision"]
    );
    assert_eq!(
        tool(&catalog(&f, &c, true).await, SIBLING),
        tool(&original, SIBLING)
    );
    let stale = toggle(&f, &c, initial, true, false).await;
    assert_eq!(stale.0, 409);
    assert_eq!(stale.1["code"], "APP_TOOL_ACCESS_CHANGED");
    let error = connections::prepare_call(&store, id, TARGET, &json!({}))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "APP_TOOL_DISABLED");
    let raw = connections::tools(&store, id).await.unwrap();
    assert_eq!(raw.len(), 1);
    assert_eq!(raw[0]["name"], SIBLING);
    assert!(raw[0].get("access").is_none());

    let (status, reconnected) = f
        .request(
            "POST",
            &f.path(&format!("/apps/{id}/reconnect")),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{reconnected}");
    assert_eq!(reconnected["status"], "connected");
    assert_ne!(reconnected["revision"], c["revision"]);
    assert_eq!(
        tool(&catalog(&f, &reconnected, false).await, TARGET),
        &disabled
    );
    assert_eq!(toggle(&f, &c, &disabled, true, false).await.0, 409);
    let enabled = set_target(&f, &reconnected, true).await;
    assert_ne!(enabled["access"]["revision"], initial["access"]["revision"]);
    assert_ne!(
        enabled["access"]["revision"],
        disabled["access"]["revision"]
    );
    assert_eq!(toggle(&f, &reconnected, initial, false, false).await.0, 409);
    f.close().await;
}

#[tokio::test]
async fn pending_target_and_late_result_are_discarded_while_sibling_approval_executes() {
    let (f, server, c, store) = setup().await;
    let target = prepare_action(&f, &store, &c, TARGET).await;
    let sibling = prepare_action(&f, &store, &c, SIBLING).await;
    set_target(&f, &c, false).await;
    assert_eq!(settled(&store, &target).await["status"], "cancelled");
    assert_eq!(approve(&f, &target).await.0, 409);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(approve(&f, &sibling).await.0, 200);
    assert_eq!(settled(&store, &sibling).await["status"], "done");
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);

    set_target(&f, &c, true).await;
    let running = prepare_action(&f, &store, &c, TARGET).await;
    server.remote.hold.store(true, Ordering::SeqCst);
    assert_eq!(approve(&f, &running).await.0, 200);
    wait_until(|| server.remote.calls.load(Ordering::SeqCst) == 2).await;
    set_target(&f, &c, false).await;
    server.remote.hold.store(false, Ordering::SeqCst);
    let stopped = settled(&store, &running).await;
    assert_eq!(stopped["status"], "error");
    assert_eq!(stopped["error"], apps::model::UNKNOWN);
    assert!(stopped.get("result").is_none());
    assert_eq!(approve(&f, &running).await.0, 409);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        tool(&catalog(&f, &c, true).await, SIBLING)["access"]["enabled"],
        true
    );
    f.close().await;
}

#[tokio::test]
async fn disabling_one_tool_during_oauth_refresh_preserves_the_rotated_connection() {
    let (f, server, c, store) = setup().await;
    let origin = &server.remote.origin;
    let grant = json!({"issuer":origin,"resource":format!("{origin}/mcp"),
        "scopes":["notes.read","notes.write"],
        "client":{"issuer":origin,"client_id":"synthetic-tool-access","token_endpoint_auth_method":"none"},
        "metadata":{"issuer":origin,"authorization_endpoint":format!("{origin}/authorize"),
            "token_endpoint":format!("{origin}/token"),"response_types_supported":["code"],
            "token_endpoint_auth_methods_supported":["none"]},
        "tokens":{"issuer":origin,"access_token":"synthetic-old","refresh_token":"synthetic-refresh",
            "token_type":"Bearer","scope":"notes.read notes.write"},"obtainedAt":1,"expiresAt":0});
    let id = c["id"].as_str().unwrap();
    sqlx::query("UPDATE app_connections SET data=json_set(data,'$.authType','oauth','$.oauth',json(?)) WHERE id=?")
        .bind(grant.to_string()).bind(id).execute(&store.pool).await.unwrap();
    server.remote.oauth.store(true, Ordering::SeqCst);
    server.remote.hold_refresh.store(true, Ordering::SeqCst);
    let target = prepare_action(&f, &store, &c, TARGET).await;
    assert_eq!(approve(&f, &target).await.0, 200);
    wait_until(|| server.remote.refreshes.load(Ordering::SeqCst) == 1).await;
    set_target(&f, &c, false).await;
    server.remote.hold_refresh.store(false, Ordering::SeqCst);
    assert_eq!(settled(&store, &target).await["status"], "error");
    let sibling = prepare_action(&f, &store, &c, SIBLING).await;
    assert_eq!(approve(&f, &sibling).await.0, 200);
    assert_eq!(settled(&store, &sibling).await["status"], "done");
    assert_eq!(server.remote.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        tool(&catalog(&f, &c, true).await, TARGET)["access"]["enabled"],
        false
    );
    f.close().await;
}
