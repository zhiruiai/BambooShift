mod apps_support;
mod workspace_support;

use apps_support::{Server, headers};
use openbot_backend::{
    apps::{self, connections, model::PreparedCall},
    config::Config,
    db::State,
    error::Result,
    workspace::access,
};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use workspace_support::Fixture;

const TOKEN_A: &str = "synthetic-before-rotation";
const TOKEN_B: &str = "synthetic-after-rotation";

fn attach_remote(fixture: &mut Fixture, server: &Server) {
    fixture.state.apps =
        Arc::new(apps::AppsRuntime::fixture(vec![server.remote.origin.clone()]).unwrap());
}

async fn persisted(fixture: &Fixture, id: &str) -> (Value, Value) {
    let store = fixture
        .state
        .workspace
        .get(&fixture.workspace, &fixture.workspace)
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM app_connections WHERE id=?")
        .bind(id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert!(!raw.contains(TOKEN_A));
    assert!(!raw.contains(TOKEN_B));
    let private = std::fs::read(store.directory.join("config/apps.private.json")).unwrap();
    (
        serde_json::from_str(&raw).unwrap(),
        serde_json::from_slice(&private).unwrap(),
    )
}

async fn prepare(fixture: &Fixture, id: &str) -> PreparedCall {
    let store = fixture
        .state
        .workspace
        .get(&fixture.workspace, &fixture.workspace)
        .await
        .unwrap();
    connections::prepare_call(&store, id, "write_note", &json!({"text":"Synthetic check"}))
        .await
        .unwrap()
}

async fn execute(fixture: &Fixture, prepared: &PreparedCall) -> Result<Value> {
    let actor = access::require(
        &fixture.state,
        &headers(&fixture.owner_token, &fixture.owner),
        &fixture.workspace,
        true,
        true,
    )
    .await?;
    let store = actor.store(&fixture.state).await?;
    connections::execute(
        &fixture.state,
        &store,
        prepared,
        apps::user_authority(&fixture.state, &actor),
    )
    .await
}

fn assert_redacted(value: &Value) {
    let text = value.to_string();
    assert!(!text.contains(TOKEN_A));
    assert!(!text.contains(TOKEN_B));
}

#[tokio::test]
async fn replacing_private_bearer_credentials_survives_reopen_and_authenticates_real_mcp() {
    let server = Server::start().await;
    // Reuse the synthetic server's token allowlist; the connection itself uses bearer auth.
    server.remote.oauth.store(true, Ordering::SeqCst);
    *server.remote.tokens.lock().await = vec![TOKEN_A.into()];
    let mut fixture = Fixture::new().await;
    attach_remote(&mut fixture, &server);
    let endpoint = format!("{}/mcp", server.remote.origin);
    let (status, first) = fixture
        .request(
            "POST",
            &fixture.path("/apps"),
            Some(json!({
                "name":"Synthetic credential rotation",
                "url":endpoint,
                "authType":"bearer",
                "token":TOKEN_A,
                "shared":true
            })),
            false,
            Some(&fixture.owner),
        )
        .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["status"], "connected");
    assert_redacted(&first);
    let id = first["id"].as_str().unwrap();
    let (saved_a, private_a) = persisted(&fixture, id).await;
    let reference_a = saved_a["credentialRef"].as_str().unwrap();
    assert_eq!(
        private_a["entries"][reference_a]["payload"]["token"],
        TOKEN_A
    );
    let previous_call = prepare(&fixture, id).await;
    let first_result = execute(&fixture, &previous_call).await.unwrap();
    assert_eq!(first_result["isError"], false);
    assert_redacted(&first_result);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);

    *server.remote.tokens.lock().await = vec![TOKEN_B.into()];
    let (status, replaced) = fixture
        .request(
            "POST",
            &fixture.path(&format!("/apps/{id}/reconnect")),
            Some(json!({"token":TOKEN_B})),
            false,
            Some(&fixture.owner),
        )
        .await;
    assert_eq!(status, 200, "{replaced}");
    assert_eq!(replaced["status"], "connected");
    assert_eq!(replaced["hasCredential"], true);
    assert_ne!(replaced["revision"], first["revision"]);
    assert_redacted(&replaced);
    let (saved_b, private_b) = persisted(&fixture, id).await;
    let reference_b = saved_b["credentialRef"].as_str().unwrap();
    assert_ne!(reference_a, reference_b);
    assert_eq!(private_b["entries"].as_object().unwrap().len(), 1);
    assert!(private_b["entries"].get(reference_a).is_none());
    assert_eq!(
        private_b["entries"][reference_b]["payload"]["token"],
        TOKEN_B
    );
    assert!(!private_b.to_string().contains(TOKEN_A));
    assert_eq!(
        execute(&fixture, &previous_call).await.unwrap_err().status,
        409
    );
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);

    fixture.state.close().await;
    fixture.state = State::open(Config::local(fixture.directory.path()))
        .await
        .unwrap();
    attach_remote(&mut fixture, &server);
    let bootstrap = fixture.bootstrap().await;
    let reopened = bootstrap["apps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|connection| connection["id"] == id)
        .unwrap();
    assert_eq!(reopened["status"], "connected");
    assert_eq!(reopened["revision"], replaced["revision"]);
    assert_eq!(reopened["hasCredential"], true);
    assert_redacted(&bootstrap);
    let (reopened_saved, reopened_private) = persisted(&fixture, id).await;
    assert_eq!(reopened_saved["credentialRef"], reference_b);
    assert_eq!(reopened_private, private_b);

    // The server now rejects A, so a successful fresh tool call proves B was loaded from disk.
    let rejected = reqwest::Client::new()
        .post(&endpoint)
        .bearer_auth(TOKEN_A)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), 401);
    let fresh_call = prepare(&fixture, id).await;
    let result = execute(&fixture, &fresh_call).await.unwrap();
    assert_eq!(result["isError"], false);
    assert!(result["text"].as_str().unwrap().contains("Synthetic check"));
    assert_redacted(&result);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 2);
    fixture.close().await;
}
