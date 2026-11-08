mod agent_delegation_support;
mod app_policy_support;
mod apps_support;
mod workspace_support;
use app_policy_support::*;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn toggling_a_routine_tool_invalidates_only_its_existing_policy_and_review_snapshot() {
    let (g, s, c, r) = setup().await;
    let mut tools = catalog();
    tools[2]["annotations"] = json!({"readOnlyHint":true});
    sqlx::query("UPDATE app_connections SET data=json_set(data,'$.tools',json(?)) WHERE id=?")
        .bind(json!(tools).to_string())
        .bind(c["id"].as_str())
        .execute(&g.store.pool)
        .await
        .unwrap();
    *s.remote.catalog.lock().await = Some(tools);
    let target = grant(&g, &c, &r).await;
    let policies = path(&g, &c);
    let target_request = body(&g, &c, &r, "read_notes").await;
    let sibling = body(&g, &c, &r, "unclassified").await;
    let (status, sibling_policy) =
        g.f.request(
            "POST",
            &policies,
            Some(sibling.clone()),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{sibling_policy}");
    let app = c["id"].as_str().unwrap();
    let route = g.f.path(&format!("/apps/{app}/tools"));
    let (_, tools) =
        g.f.request("GET", &route, None, false, Some(&g.f.owner))
            .await;
    let mut proof = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "read_notes")
        .unwrap()["access"]["revision"]
        .clone();
    for enabled in [false, true] {
        let (status, toggled) = g.f.request("PUT", &format!("{route}/access"), Some(json!({
            "toolName":"read_notes","enabled":enabled,"expectedConnectionRevision":c["revision"],"expectedToolRevision":proof,
        })), false, Some(&g.f.owner)).await;
        assert_eq!(status, 200, "{toggled}");
        proof = toggled["access"]["revision"].clone();
        let (_, list) =
            g.f.request("GET", &policies, None, false, Some(&g.f.owner))
                .await;
        assert_eq!(
            list.as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == target["id"])
                .unwrap()["status"],
            "invalidated"
        );
        assert_eq!(
            list.as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == sibling_policy["id"])
                .unwrap()["status"],
            "active"
        );
        let (_, options) =
            g.f.request(
                "GET",
                &format!("{policies}/options"),
                None,
                false,
                Some(&g.f.owner),
            )
            .await;
        let target_option = options["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["tool"]["name"] == "read_notes");
        assert_eq!(target_option.is_some(), enabled);
        if let Some(option) = target_option {
            assert_ne!(option["revision"], target_request["toolRevision"]);
        }
        assert_eq!(options["catalogRevision"], sibling["catalogRevision"]);
    }
    let (status, stale) =
        g.f.request(
            "POST",
            &policies,
            Some(target_request),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(status, 409, "{stale}");
    let m = Model::new(model(&c, "unclassified", json!({"query":"newer_than:1d"}))).await;
    g.configure(&m).await;
    schedule(&g, &r).await;
    g.done().await;
    assert_eq!(
        action(&g, "done").await["policy"]["policyId"],
        sibling_policy["id"]
    );
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 1);
    g.close().await;
}

#[tokio::test]
async fn fresh_catalog_change_outside_the_selected_tool_prevents_network_dispatch() {
    let (g, s, c, r) = setup().await;
    grant(&g, &c, &r).await;
    let mut changed = catalog();
    changed[1]["description"] = json!("A different write scope");
    *s.remote.catalog.lock().await = Some(changed);
    let m = Model::new(model(&c, "read_notes", json!({"query":"newer_than:1d"}))).await;
    g.configure(&m).await;
    schedule(&g, &r).await;
    g.done().await;
    let a = action(&g, "error").await;
    assert!(a.get("result").is_none());
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .1[0]["status"],
        "invalidated"
    );
    drop(m);
    drop(s);
    g.close().await;
}
#[tokio::test]
async fn stable_oauth_refresh_preserves_scope_but_new_authorization_permanently_invalidates_it() {
    let (g, s, c, r) = setup().await;
    s.remote.bearer.store(false, Ordering::SeqCst);
    s.remote.oauth.store(true, Ordering::SeqCst);
    let origin = &s.remote.origin;
    let old = "synthetic-expired-policy-token";
    s.remote.tokens.lock().await.push(old.into());
    let grant_data = json!({"issuer":origin,"resource":format!("{origin}/mcp"),"scopes":["notes.read","notes.write"],"client":{"issuer":origin,"client_id":"synthetic-policy-client","token_endpoint_auth_method":"none"},"metadata":{"issuer":origin,"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"response_types_supported":["code"],"token_endpoint_auth_methods_supported":["none"]},"tokens":{"issuer":origin,"access_token":old,"refresh_token":"synthetic-refresh","token_type":"Bearer","scope":"notes.read notes.write"},"obtainedAt":1,"expiresAt":0});
    // A synthetic legacy grant exercises the real refresh and private-file migration path.
    sqlx::query("UPDATE app_connections SET data=json_set(json_remove(data,'$.credentialRef'),'$.authType','oauth','$.oauth',json(?),'$.authorization',json(?)) WHERE id=?")
        .bind(grant_data.to_string()).bind(json!({"issuer":origin,"scopes":["notes.read","notes.write"]}).to_string()).bind(c["id"].as_str()).execute(&g.store.pool).await.unwrap();
    let policy = grant(&g, &c, &r).await;
    let m = Model::new(model(&c, "read_notes", json!({"query":"newer_than:1d"}))).await;
    g.configure(&m).await;
    schedule(&g, &r).await;
    g.done().await;
    let messages = g
        .store
        .list(openbot_backend::workspace::Table::Messages)
        .await
        .unwrap();
    let actual = messages
        .iter()
        .find_map(|m| m["metadata"].get("appAction"))
        .expect("An actual app receipt");
    assert_eq!(
        actual["status"],
        "done",
        "receipt={actual}; refreshes={}; policies={}",
        s.remote.refreshes.load(Ordering::SeqCst),
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .1
    );
    assert_eq!(actual["policy"]["policyId"], policy["id"]);
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(s.remote.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .1[0]["status"],
        "active"
    );
    let saved: String = sqlx::query_scalar("SELECT data FROM app_connections WHERE id=?")
        .bind(c["id"].as_str())
        .fetch_one(&g.store.pool)
        .await
        .unwrap();
    let saved: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved["revision"], c["revision"]);
    assert!(saved["credentialRef"].is_string());
    assert!(saved.get("oauth").is_none());
    let start =
        g.f.request(
            "POST",
            &g.f.path(&format!("/apps/{}/oauth/start", c["id"].as_str().unwrap())),
            Some(json!({"expectedRevision":saved["revision"]})),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(start.0, 200, "{}", start.1);
    assert_eq!(
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .1[0]["status"],
        "invalidated"
    );
    drop(m);
    drop(s);
    g.close().await;
}
#[tokio::test]
async fn changing_connection_identity_or_cached_annotations_invalidates_even_when_restored() {
    for key in ["url", "authorization", "annotations"] {
        let (g, s, c, r) = setup().await;
        grant(&g, &c, &r).await;
        let original: String = sqlx::query_scalar("SELECT data FROM app_connections WHERE id=?")
            .bind(c["id"].as_str())
            .fetch_one(&g.store.pool)
            .await
            .unwrap();
        let mut changed: Value = serde_json::from_str(&original).unwrap();
        match key {
            "url" => changed["url"] = json!("https://different.example.test/mcp"),
            "authorization" => {
                changed["authorization"] =
                    json!({"issuer":"https://different.example.test","scopes":["read"]})
            }
            _ => changed["tools"][0]["annotations"]["readOnlyHint"] = json!(false),
        }
        for value in [changed.to_string(), original] {
            sqlx::query("UPDATE app_connections SET data=? WHERE id=?")
                .bind(value)
                .bind(c["id"].as_str())
                .execute(&g.store.pool)
                .await
                .unwrap();
        }
        assert_eq!(
            g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
                .await
                .1[0]["status"],
            "invalidated",
            "{key}"
        );
        assert_eq!(s.remote.calls.load(Ordering::SeqCst), 0);
        drop(s);
        g.close().await;
    }
}
