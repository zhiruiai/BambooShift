mod bot_templates_support;
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use bot_templates_support::{Templates, id, token, webp};
use openbot_backend::{config::Config, db::State, workspace::Table};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn failed_chat_projection_is_explicit_and_get_is_readonly_until_owner_sync() {
    let t = Templates::new().await;
    sqlx::query("CREATE TRIGGER refuse_template_card BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&t.store.pool).await.unwrap();
    let draft = t.create().await;
    assert_eq!(draft["projectionPending"], true);
    assert!(t.store.list(Table::Messages).await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER refuse_template_card")
        .execute(&t.store.pool)
        .await
        .unwrap();
    let path = format!("/bot-templates/{}", draft["id"].as_str().unwrap());
    let (status, get) = t.call("GET", &path, None).await;
    assert_eq!(status, 200);
    assert_eq!(get["projectionPending"], true);
    assert!(t.store.list(Table::Messages).await.unwrap().is_empty());
    let (status, synced) = t
        .call("POST", &(path.clone() + "/sync"), Some(json!({})))
        .await;
    assert_eq!(status, 200, "{synced}");
    assert_eq!(synced["projectionPending"], false);
    assert_eq!(t.store.list(Table::Messages).await.unwrap().len(), 1);
    assert_eq!(
        t.call("POST", &(path + "/sync"), Some(json!({}))).await.0,
        200
    );
    assert_eq!(t.store.list(Table::Messages).await.unwrap().len(), 1);
    t.close().await;
}
#[tokio::test]
async fn same_link_updates_avatar_version_and_old_revision_never_returns_new_bytes() {
    let t = Templates::new().await;
    t.public_policy().await;
    let mut bot = t.store.get(Table::Agents, &t.agent).await.unwrap().unwrap();
    let asset = id();
    let bytes = webp();
    sqlx::query("INSERT INTO avatar_assets VALUES(?,?,?,1)")
        .bind(&asset)
        .bind(json!({"id":asset,"width":512,"height":512,"mimeType":"image/webp"}).to_string())
        .bind(&bytes)
        .execute(&t.store.pool)
        .await
        .unwrap();
    bot["avatarImageId"] = json!(asset);
    t.store.put(Table::Agents, &bot).await.unwrap();
    let first = t.publish(&t.create().await, "public").await;
    let link = token(&first);
    let old = first["publication"]["revision"].as_str().unwrap();
    let asset = id();
    let rgba = vec![22_u8; 512 * 512 * 4];
    let next = webp::Encoder::from_rgba(&rgba, 512, 512)
        .encode_lossless()
        .to_vec();
    sqlx::query("INSERT INTO avatar_assets VALUES(?,?,?,1)")
        .bind(&asset)
        .bind(json!({"id":asset,"width":512,"height":512,"mimeType":"image/webp"}).to_string())
        .bind(&next)
        .execute(&t.store.pool)
        .await
        .unwrap();
    bot["avatarImageId"] = json!(asset);
    t.store.put(Table::Agents, &bot).await.unwrap();
    let preview = t.source().await;
    let (status,refreshed)=t.call("POST",&format!("/bot-templates/{}/refresh",first["id"].as_str().unwrap()),Some(json!({"requestId":id(),"expectedRevision":first["revision"],"expectedSourceRevision":preview["sourceRevision"]}))).await;
    assert_eq!(status, 200, "{refreshed}");
    let second = t.publish(&refreshed, "public").await;
    assert_eq!(token(&second), link);
    let (status, error) =
        t.f.with_cookie(
            "GET",
            &format!("/api/bot-template-links/{link}/avatar?revision={old}"),
            None,
            "",
            None,
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(error["code"], "BOT_TEMPLATE_VERSION_CHANGED");
    let mut request = Request::builder()
        .uri(format!(
            "/api/bot-template-links/{link}/avatar?revision={}",
            second["publication"]["revision"].as_str().unwrap()
        ))
        .header("host", "127.0.0.1:3002")
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:45555".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(t.f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let result = to_bytes(response.into_body(), 600_000).await.unwrap();
    assert_eq!(result.as_ref(), next);
    assert_ne!(result.as_ref(), bytes);
    t.close().await;
}
#[tokio::test]
async fn node_install_receipt_digest_and_publication_survive_rust_restart_without_replay() {
    let mut t = Templates::new().await;
    t.public_policy().await;
    let published = t.publish(&t.create().await, "public").await;
    let link = token(&published);
    let request = "00000000-0000-4000-8000-000000000111";
    let receipt = json!({"requestId":request,"agentId":t.agent,"conversationId":t.conversation,"skillIds":[],"routineIds":[],"createdAt":"2026-11-01T00:00:00.000Z"});
    // This digest is produced by the original Node canonical serializer, not the Rust implementation.
    sqlx::query("INSERT INTO bot_install_receipts VALUES(?,?,?,?)")
        .bind(request)
        .bind(format!("user:{}", t.f.owner))
        .bind("a055169de9acd8079ff14a5ea28de68dafd0267fb1c94a3b7a0f0ba985e6a5bd")
        .bind(receipt.to_string())
        .execute(&t.store.pool)
        .await
        .unwrap();
    t.f.state.close().await;
    t.f.state = State::open(Config::local(t.f.directory.path()))
        .await
        .unwrap();
    t.store =
        t.f.state
            .workspace
            .get(&t.f.workspace, &t.f.workspace)
            .await
            .unwrap();
    let body = json!({"requestId":request,"agentId":"old-source","expectedSourceRevision":"old-source-revision","name":"Original Node copy","routineMode":"pause"});
    let (status, found) = t.call("POST", "/bot-copies", Some(body)).await;
    assert_eq!(status, 201, "{found}");
    assert_eq!(found, receipt);
    assert_eq!(t.store.list(Table::Agents).await.unwrap().len(), 1);
    let (status, preview) =
        t.f.with_cookie(
            "GET",
            &format!("/api/bot-template-links/{link}"),
            None,
            "",
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(preview["revision"], published["publication"]["revision"]);
    t.close().await;
}
#[tokio::test]
async fn cross_site_navigation_exception_is_strictly_html_get_with_no_query_or_body() {
    let t = Templates::new().await;
    let runtime = t.f.directory.path().join("navigation-runtime");
    std::fs::create_dir_all(runtime.join("dist")).unwrap();
    std::fs::write(
        runtime.join("dist/index.html"),
        "<!doctype html><title>Synthetic template UI</title>",
    )
    .unwrap();
    let mut state = t.f.state.clone();
    let mut config = (*state.config).clone();
    config.runtime_dir = runtime;
    state.config = std::sync::Arc::new(config);
    let token = "a".repeat(43);
    for (method, path, body, expected) in [
        ("GET", format!("/templates/{token}"), "", 200),
        ("POST", format!("/templates/{token}"), "", 400),
        ("GET", format!("/templates/{token}?next=evil"), "", 400),
        ("GET", format!("/templates/{token}"), "data", 400),
        ("GET", format!("/api/bot-template-links/{token}"), "", 403),
        ("GET", "/templates/short".to_owned(), "", 403),
    ] {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "127.0.0.1:3002")
            .header("sec-fetch-site", "cross-site")
            .header("content-length", body.len())
            .body(Body::from(body))
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:45555".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let response = openbot_backend::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
        assert_eq!(
            response.headers().get("referrer-policy").unwrap(),
            "no-referrer"
        );
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        if expected == 200 {
            assert_eq!(
                response.headers()["content-type"],
                "text/html; charset=utf-8"
            );
            assert!(
                response.headers()["content-security-policy"]
                    .to_str()
                    .unwrap()
                    .contains("frame-ancestors 'none'")
            );
            assert!(
                String::from_utf8(
                    to_bytes(response.into_body(), 65536)
                        .await
                        .unwrap()
                        .to_vec()
                )
                .unwrap()
                .contains("Synthetic template UI")
            );
        }
    }
    t.close().await;
}
