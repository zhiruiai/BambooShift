mod workspace_support;

use axum::{body::Body, extract::ConnectInfo, http::Request};
use serde_json::{Value, json};
use std::net::SocketAddr;
use tower::ServiceExt;
use workspace_support::Fixture;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../shared/fixtures/remote-mcp-import.json"
    ))
    .unwrap()
}

async fn preview(f: &Fixture, body: Value) -> Value {
    let (status, value) = f
        .request(
            "POST",
            &f.path("/apps/import/preview"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value
}

#[tokio::test]
async fn shared_url_and_projection_contract_is_normalized_without_side_effects() {
    let f = Fixture::new().await;
    let space = f.directory.path().join("spaces").join(&f.workspace);
    assert!(!space.exists());
    // A stopped worker runtime cannot connect apps; pure previews remain available.
    f.state.apps.close(&f.state).await;
    let fixture = fixtures();
    for case in fixture["addresses"].as_array().unwrap() {
        let result = preview(
            &f,
            json!({
                "candidates":[{"name":"Synthetic app","url":case["input"]}],"skipped":0,
            }),
        )
        .await;
        let expected = if case["url"].is_null() {
            json!({"candidates":[],"skipped":1,"error":"empty"})
        } else {
            json!({"candidates":[{"name":"Synthetic app","url":case["url"]}],"skipped":0,"error":null})
        };
        assert_eq!(result, expected, "{}", case["name"]);
    }
    for case in fixture["cases"].as_array().unwrap() {
        let projection = &case["projectionExpected"];
        if projection["ok"] != true {
            continue;
        }
        let result = preview(
            &f,
            json!({
                "candidates":projection["candidates"],"skipped":projection["skipped"],
            }),
        )
        .await;
        let expected = &case["expected"];
        if expected["ok"] == true {
            assert_eq!(
                result,
                json!({
                    "candidates":expected["candidates"],"skipped":expected["skipped"],"error":null,
                }),
                "{}",
                case["name"]
            );
        } else {
            assert_eq!(result["error"], "empty", "{}", case["name"]);
            assert_eq!(result["candidates"], json!([]));
        }
        assert!(!result.to_string().contains("SYNTHETIC_"));
    }
    assert!(
        !space.exists(),
        "preview must not initialize workspace data"
    );
    let grants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_oauth_index")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(grants, 0);
    f.close().await;
}

#[tokio::test]
async fn schema_and_batch_limits_are_strict_and_never_echo_unknown_fields() {
    let f = Fixture::new().await;
    let valid = json!({"name":"Synthetic app","url":"https://example.com/mcp"});
    for body in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"candidates":[]}),
        json!({"candidates":[],"skipped":-1}),
        json!({"candidates":[],"skipped":1.5}),
        json!({"candidates":[],"skipped":"0"}),
        json!({"candidates":[],"skipped":null}),
        json!({"candidates":[],"skipped":101}),
        json!({"candidates":[],"skipped":18446744073709551615u64}),
        json!({"candidates":[],"skipped":0,"token":"SYNTHETIC_SECRET"}),
        json!({"candidates":{},"skipped":0}),
        json!({"candidates":[null],"skipped":0}),
        json!({"candidates":[{"name":"Synthetic app"}],"skipped":0}),
        json!({"candidates":[{"name":1,"url":"https://example.com"}],"skipped":0}),
        json!({"candidates":[{"name":"Synthetic app","url":1}],"skipped":0}),
        json!({"candidates":[{"name":"Synthetic app","url":"https://example.com","headers":{"Authorization":"SYNTHETIC_SECRET"}}],"skipped":0}),
        json!({"candidates":vec![valid.clone();101],"skipped":0}),
        json!({"candidates":vec![valid.clone();100],"skipped":1}),
    ] {
        let (status, value) = f
            .request(
                "POST",
                &f.path("/apps/import/preview"),
                Some(body),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 400, "{value}");
        assert_eq!(value["code"], "BAD_REQUEST");
        assert!(!value.to_string().contains("SYNTHETIC_SECRET"));
    }
    assert_eq!(
        preview(&f, json!({"candidates":[],"skipped":100})).await,
        json!({"candidates":[],"skipped":100,"error":"empty"})
    );
    assert_eq!(
        preview(
            &f,
            json!({"candidates":vec![valid.clone();100],"skipped":0})
        )
        .await,
        json!({"candidates":[valid],"skipped":99,"error":null})
    );
    let mut malformed = Request::builder()
        .method("POST")
        .uri(f.path("/apps/import/preview"))
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header("cookie", format!("openbot_account={}", f.owner_token))
        .header("x-openbot-expected-user", &f.owner)
        .header("content-type", "application/json")
        .body(Body::from("{invalid SYNTHETIC_SECRET"))
        .unwrap();
    malformed.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41321".parse::<SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(malformed)
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    f.close().await;
}

#[tokio::test]
async fn unicode_names_and_raw_and_normalized_url_byte_limits_are_bounded() {
    let f = Fixture::new().await;
    let name = "🐼".repeat(40);
    let prefix = "https://example.com/";
    let boundary_url = format!("{prefix}{}", "a".repeat(2048 - prefix.len()));
    let mut candidates = vec![
        json!({"name":name,"url":boundary_url}),
        json!({"name":"🐼".repeat(41),"url":"https://example.com/long-name"}),
        json!({"name":format!("{}App", " ".repeat(80)),"url":"https://example.com/padded-name"}),
        json!({"name":"raw too long","url":format!("{boundary_url}a")}),
        json!({"name":"normalized too long","url":format!("{prefix}{}","文".repeat(230))}),
    ];
    for invalid in fixtures()["invalidNames"].as_array().unwrap() {
        candidates.push(json!({"name":invalid,"url":"https://example.com/invalid-name"}));
    }
    let skipped = candidates.len() - 1;
    assert_eq!(
        preview(&f, json!({"candidates":candidates,"skipped":0})).await,
        json!({"candidates":[{"name":name,"url":boundary_url}],"skipped":skipped,"error":null})
    );
    assert_eq!(
        preview(
            &f,
            json!({"candidates":[
        {"name":"First","url":"https://bu\u{0308}cher.example:443/a/../mcp"},
        {"name":"Second","url":"https://xn--bcher-kva.example/mcp"},
        {"name":"  Trimmed  ","url":"https://other.example.com/"},
    ],"skipped":2})
        )
        .await,
        json!({"candidates":[
        {"name":"First","url":"https://xn--bcher-kva.example/mcp"},
        {"name":"Trimmed","url":"https://other.example.com/"},
    ],"skipped":3,"error":null})
    );
    f.close().await;
}

#[tokio::test]
async fn preview_requires_current_workspace_owner_and_expected_identity() {
    let f = Fixture::new().await;
    let body = json!({"candidates":[{"name":"Synthetic app","url":"https://example.com/mcp"}],"skipped":0});
    let path = f.path("/apps/import/preview");
    for (member, expected) in [
        (true, Some(f.member.as_str())),
        (false, None),
        (false, Some(f.member.as_str())),
    ] {
        assert_eq!(
            f.request("POST", &path, Some(body.clone()), member, expected)
                .await
                .0,
            403
        );
    }
    assert_eq!(
        f.with_cookie("POST", &path, Some(body.clone()), "", Some(&f.owner))
            .await
            .0,
        401
    );
    assert_eq!(
        f.with_cookie(
            "POST",
            &path,
            Some(body.clone()),
            &format!("openbot_operator={}", f.operator_token),
            Some(&f.owner)
        )
        .await
        .0,
        401
    );
    let foreign = format!("/api/workspaces/{}/apps/import/preview", f.foreign);
    assert_eq!(
        f.request("POST", &foreign, Some(body.clone()), false, Some(&f.owner))
            .await
            .0,
        403
    );
    sqlx::query("UPDATE memberships SET role='member' WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        f.request("POST", &path, Some(body), false, Some(&f.owner))
            .await
            .0,
        403
    );
    assert!(
        !f.directory
            .path()
            .join("spaces")
            .join(&f.workspace)
            .exists()
    );
    f.close().await;
}

#[tokio::test]
async fn preview_keeps_product_origin_guards_and_is_not_an_operations_route() {
    use openbot_backend::{config::OperationsConfig, operations_router, product_router};
    use std::sync::Arc;

    let f = Fixture::new().await;
    let request = |host: &str, origin: &str, fetch_site: &str| {
        let mut request = Request::builder()
            .method("POST")
            .uri(f.path("/apps/import/preview"))
            .header("host", host)
            .header("origin", origin)
            .header("sec-fetch-site", fetch_site)
            .header("cookie", format!("openbot_account={}", f.owner_token))
            .header("x-openbot-expected-user", &f.owner)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"candidates":[{"name":"Synthetic app","url":"https://example.com/mcp"}],"skipped":0}"#))
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:41321".parse::<SocketAddr>().unwrap(),
        ));
        request
    };
    for (origin, fetch_site, expected) in [
        ("http://127.0.0.1:3002", "same-origin", 200),
        ("https://attacker.example", "same-origin", 403),
        ("http://127.0.0.1:3002", "cross-site", 403),
    ] {
        let response = product_router(f.state.clone())
            .oneshot(request("127.0.0.1:3002", origin, fetch_site))
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let mut operations_state = f.state.clone();
    Arc::make_mut(&mut operations_state.config).operations = Some(OperationsConfig {
        bind: "127.0.0.1:3003".parse().unwrap(),
        public_origin: None,
        web_origin: None,
    });
    let response = operations_router(operations_state)
        .oneshot(request(
            "127.0.0.1:3003",
            "http://127.0.0.1:3003",
            "same-origin",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    f.close().await;
}

#[tokio::test]
async fn only_preview_accepts_large_utf8_projection_with_a_bounded_request_body() {
    let f = Fixture::new().await;
    let candidates: Vec<_> = (0..100)
        .map(|index| {
            json!({
                "name":format!("{index:0>80}"),
                "url":format!("https://example.com/{}{index}", "文".repeat(200)),
            })
        })
        .collect();
    let body = json!({"candidates":candidates,"skipped":0});
    assert!((60_000..90_000).contains(&body.to_string().len()));
    assert!(body.to_string().len() > 64 * 1024);
    let result = preview(&f, body.clone()).await;
    assert_eq!(result["candidates"].as_array().unwrap().len(), 100);
    assert_eq!(result["skipped"], 0);
    assert_eq!(result["error"], Value::Null);
    assert_eq!(
        f.request("POST", &f.path("/apps"), Some(body), false, Some(&f.owner))
            .await
            .0,
        413
    );
    let (status, value) = f.request("POST", &f.path("/apps/import/preview"),
        Some(json!({"candidates":[{"name":"Synthetic app","url":"a".repeat(256 * 1024)}],"skipped":0})),
        false, Some(&f.owner)).await;
    assert_eq!(status, 413);
    assert_eq!(value["code"], "PAYLOAD_TOO_LARGE");
    f.close().await;
}
