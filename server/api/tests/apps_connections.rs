mod apps_support;
mod workspace_support;
use apps_support::*;
use openbot_backend::{
    apps::{self, actions, connections},
    workspace::access,
};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use workspace_support::Fixture;

async fn setup() -> (Fixture, Server) {
    let server = Server::start().await;
    let mut fixture = Fixture::new().await;
    fixture.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
    (fixture, server)
}
async fn connect(f: &Fixture, s: &Server, auth: &str) -> Value {
    let mut body = json!({"name":"Notes","url":format!("{}/mcp",s.remote.origin),"authType":auth,"shared":true});
    if auth == "bearer" {
        body["token"] = json!("synthetic-access");
    }
    let (status, value) = f
        .request("POST", &f.path("/apps"), Some(body), false, Some(&f.owner))
        .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "connected", "{value}");
    value
}
async fn action(f: &Fixture, c: &Value) -> Value {
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
    let store = actor.store(&f.state).await.unwrap();
    let prepared = connections::prepare_call(
        &store,
        c["id"].as_str().unwrap(),
        "write_note",
        &json!({"text":"hello"}),
    )
    .await
    .unwrap();
    actions::request(
        &f.state,
        store.clone(),
        store,
        actions::ActionContext {
            conversation_id: chat["id"].as_str().unwrap().into(),
            thread_root_id: None,
            agent_id: chat["agentIds"][0].as_str().unwrap().into(),
            run_id: "synthetic-root".into(),
            requester: Some(json!({"userId":f.member,"name":"Member"})),
            source: None,
        },
        prepared,
        apps::user_authority(&f.state, &actor),
    )
    .await
    .unwrap()
}
async fn settled(f: &Fixture, id: &str) -> Value {
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    for _ in 0..200 {
        let a = actions::get(&store, id).await.unwrap();
        if actions::terminal(&a) {
            return a;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("action did not settle")
}
#[tokio::test]
async fn real_mcp_catalog_and_private_credentials_preserve_roles_and_scope() {
    let (f, s) = setup().await;
    s.remote.bearer.store(true, Ordering::SeqCst);
    let c = connect(&f, &s, "bearer").await;
    assert!(!c.to_string().contains("synthetic-access"));
    assert_eq!(c["hasCredential"], true);
    assert_eq!(c["toolCount"], 1);
    let (status, tools) = f
        .request(
            "GET",
            &f.path(&format!("/apps/{}/tools", c["id"].as_str().unwrap())),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(tools[0]["name"], "write_note");
    assert_eq!(
        f.request(
            "POST",
            &f.path("/apps"),
            Some(json!({})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/apps"),
            Some(json!({})),
            false,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM app_connections")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert!(!raw.contains("synthetic-access"));
    let private =
        std::fs::read_to_string(store.directory.join("config/apps.private.json")).unwrap();
    assert!(private.contains("synthetic-access"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(store.directory.join("config/apps.private.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    f.close().await;
}
#[tokio::test]
async fn only_requester_can_approve_and_one_external_call_is_persisted_and_redacted() {
    let (f, s) = setup().await;
    s.remote.bearer.store(true, Ordering::SeqCst);
    let c = connect(&f, &s, "bearer").await;
    let a = action(&f, &c).await;
    let path = f.path(&format!(
        "/app-actions/{}/decision",
        a["id"].as_str().unwrap()
    ));
    assert_eq!(
        f.request(
            "POST",
            &path,
            Some(json!({"approve":true})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        403
    );
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 0);
    let (status, value) = f
        .request(
            "POST",
            &path,
            Some(json!({"approve":true})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "running");
    let result = settled(&f, a["id"].as_str().unwrap()).await;
    assert_eq!(result["status"], "done", "{result}");
    assert!(!result.to_string().contains("synthetic-access"));
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.request(
            "POST",
            &path,
            Some(json!({"approve":true})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        409
    );
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 1);
    let b = f.bootstrap().await;
    assert!(
        b["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["metadata"]["appAction"]["id"] == a["id"]
                && m["metadata"]["appAction"]["status"] == "done")
    );
    f.close().await;
}
#[tokio::test]
async fn changed_live_catalog_does_not_execute_previously_approved_tool() {
    let (f, s) = setup().await;
    let c = connect(&f, &s, "none").await;
    let a = action(&f, &c).await;
    s.remote.metadata_changed.store(true, Ordering::SeqCst);
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!(
                "/app-actions/{}/decision",
                a["id"].as_str().unwrap()
            )),
            Some(json!({"approve":true})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        200
    );
    let result = settled(&f, a["id"].as_str().unwrap()).await;
    assert_eq!(result["status"], "error");
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 0);
    f.close().await;
}
#[tokio::test]
async fn disconnect_cancels_pending_and_running_never_claims_rollback() {
    let (f, s) = setup().await;
    let c = connect(&f, &s, "none").await;
    let pending = action(&f, &c).await;
    let running = action(&f, &c).await;
    s.remote.hold.store(true, Ordering::SeqCst);
    assert_eq!(
        f.request(
            "POST",
            &f.path(&format!(
                "/app-actions/{}/decision",
                running["id"].as_str().unwrap()
            )),
            Some(json!({"approve":true})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        200
    );
    wait_until(|| s.remote.calls.load(Ordering::SeqCst) == 1).await;
    let (status, c) = f
        .request(
            "POST",
            &f.path(&format!("/apps/{}/disconnect", c["id"].as_str().unwrap())),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{c}");
    assert_eq!(c["status"], "disconnected");
    assert_eq!(
        settled(&f, pending["id"].as_str().unwrap()).await["status"],
        "cancelled"
    );
    let unknown = settled(&f, running["id"].as_str().unwrap()).await;
    assert_eq!(unknown["status"], "error");
    assert!(unknown["error"].as_str().unwrap().contains("结果未知"));
    s.remote.hold.store(false, Ordering::SeqCst);
    f.close().await;
}
#[tokio::test]
async fn revoked_requester_session_cannot_execute_pending_action() {
    let (f, s) = setup().await;
    let c = connect(&f, &s, "none").await;
    let a = action(&f, &c).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        settled(&f, a["id"].as_str().unwrap()).await["status"],
        "cancelled"
    );
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 0);
    f.close().await;
}
#[tokio::test]
async fn production_network_rules_do_not_accept_http_or_self_endpoint() {
    let f = Fixture::new().await;
    let body =
        json!({"name":"No access","url":"http://127.0.0.1:1/mcp","authType":"none","shared":true});
    assert_eq!(
        f.request("POST", &f.path("/apps"), Some(body), false, Some(&f.owner))
            .await
            .0,
        400
    );
    assert_eq!(f.bootstrap().await["apps"], json!([]));
    f.close().await;
}
