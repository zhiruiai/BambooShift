mod agent_delegation_support;
mod scheduling_support;
mod workspace_support;

use agent_delegation_support::{Model, finish};
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use openbot_backend::{config::Config, db::State, workspace::Table};
use scheduling_support::{routine, store, wait};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use tower::ServiceExt;
use workspace_support::Fixture;

fn manage(f: &Fixture, routine: &Value) -> String {
    f.path(&format!(
        "/routines/{}/webhook",
        routine["id"].as_str().unwrap()
    ))
}

async fn owner(f: &Fixture, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    f.request(method, path, body, false, Some(&f.owner)).await
}

async fn rotate(f: &Fixture, path: &str, prior: &Value) -> Value {
    let (status, key) = owner(f, "PUT", path, Some(json!({"expectedRevision":prior}))).await;
    assert_eq!(status, 200, "{key}");
    assert_eq!(key["enabled"], true);
    assert_eq!(key["secret"].as_str().unwrap().len(), 43);
    assert!(uuid::Uuid::parse_str(key["revision"].as_str().unwrap()).is_ok());
    key
}

async fn raw(
    f: &Fixture,
    path: &str,
    request_headers: &[(&str, &str)],
    body: String,
    operations: bool,
) -> (u16, HeaderMap, Value) {
    let host = if f.state.config.public_origin.is_some() {
        "openbot.example.test"
    } else {
        "127.0.0.1:3002"
    };
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("host", host);
    for (key, value) in request_headers {
        request = request.header(*key, *value);
    }
    let mut request = request.body(Body::from(body)).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:45555".parse::<SocketAddr>().unwrap(),
    ));
    let router = if operations {
        openbot_backend::operations_router(f.state.clone())
    } else {
        openbot_backend::product_router(f.state.clone())
    };
    let response = router.oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 64 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (parts.status.as_u16(), parts.headers, value)
}

async fn deliver(
    f: &Fixture,
    key: &Value,
    id: Option<&str>,
    body: &str,
) -> (u16, HeaderMap, Value) {
    let bearer = format!("Bearer {}", key["secret"].as_str().unwrap());
    let mut headers = vec![
        ("authorization", bearer.as_str()),
        ("content-type", "application/json"),
    ];
    if let Some(id) = id {
        headers.push(("idempotency-key", id));
    }
    raw(
        f,
        key["path"].as_str().unwrap(),
        &headers,
        body.into(),
        false,
    )
    .await
}

#[tokio::test]
async fn keys_are_owner_scoped_revisioned_one_time_and_bearer_only() {
    let mut f = Fixture::new().await;
    let routine = routine(&f).await;
    let path = manage(&f, &routine);
    assert_eq!(
        owner(&f, "GET", &path, None).await,
        (200, json!({"enabled":false,"revision":"unset"}))
    );
    assert_eq!(
        f.request("GET", &path, None, true, Some(&f.member)).await.0,
        403
    );
    assert_eq!(
        f.request(
            "PUT",
            &path,
            Some(json!({"expectedRevision":"unset"})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    assert_eq!(f.request("GET", &path, None, false, None).await.0, 403);
    let first = rotate(&f, &path, &json!("unset")).await;
    let (_, view) = owner(&f, "GET", &path, None).await;
    assert_eq!(
        view,
        json!({"enabled":true,"revision":first["revision"],"path":first["path"]})
    );
    assert_eq!(
        owner(&f, "PUT", &path, Some(json!({"expectedRevision":"unset"})))
            .await
            .1["code"],
        "ROUTINE_WEBHOOK_CHANGED"
    );
    let second = rotate(&f, &path, &first["revision"]).await;
    assert_ne!(second["secret"], first["secret"]);
    assert_eq!(second["path"], first["path"]);
    let (status, headers, denied) = deliver(&f, &first, None, "{}").await;
    assert_eq!(
        (status, denied["code"].as_str()),
        (401, Some("ROUTINE_WEBHOOK_UNAUTHORIZED"))
    );
    assert_eq!(headers["www-authenticate"], "Bearer");
    assert_eq!(headers["cache-control"], "no-store");
    let persisted: String =
        sqlx::query_scalar("SELECT key_digest FROM routine_webhook_keys WHERE workspace_id=?")
            .bind(&f.workspace)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(persisted.len(), 64);
    assert!(!persisted.contains(second["secret"].as_str().unwrap()));

    f.state.close().await;
    let mut config = Config::local(f.directory.path());
    config.public_origin = Some("https://openbot.example.test".into());
    f.state = State::open(config).await.unwrap();
    let hook = second["path"].as_str().unwrap();
    let auth = format!("Bearer {}", second["secret"].as_str().unwrap());
    let cookie = format!("openbot_account={}", f.owner_token);
    for (headers, want) in [
        (vec![], 401),
        (
            vec![
                ("authorization", auth.as_str()),
                ("cookie", cookie.as_str()),
            ],
            403,
        ),
        (
            vec![
                ("authorization", auth.as_str()),
                ("origin", "https://evil.example.test"),
            ],
            403,
        ),
        (
            vec![
                ("authorization", auth.as_str()),
                ("sec-fetch-site", "cross-site"),
            ],
            403,
        ),
        (
            vec![
                ("authorization", auth.as_str()),
                ("authorization", auth.as_str()),
            ],
            401,
        ),
    ] {
        assert_eq!(raw(&f, hook, &headers, String::new(), false).await.0, want);
    }
    assert_eq!(
        raw(
            &f,
            &format!("{hook}?secret=forbidden"),
            &[("authorization", &auth)],
            String::new(),
            false
        )
        .await
        .0,
        403
    );
    let unknown = hook.replace(&f.workspace, &f.foreign);
    assert_eq!(
        raw(
            &f,
            &unknown,
            &[("authorization", &auth)],
            String::new(),
            false
        )
        .await
        .0,
        401
    );
    assert!(!f.directory.path().join("spaces").join(&f.foreign).exists());
    assert_ne!(
        raw(&f, hook, &[("authorization", &auth)], String::new(), true)
            .await
            .0,
        202
    );
    assert_eq!(
        deliver(&f, &second, None, "{}").await.2["code"],
        "ROUTINE_WEBHOOK_MODEL_UNAVAILABLE"
    );
    for bad in ["[]", "null", "not JSON"] {
        assert_eq!(
            deliver(&f, &second, None, bad).await.2["code"],
            "ROUTINE_WEBHOOK_BODY"
        );
    }
    assert_eq!(
        deliver(&f, &second, Some("contains spaces"), "{}").await.2["code"],
        "ROUTINE_WEBHOOK_IDEMPOTENCY_KEY"
    );
    assert_eq!(deliver(&f, &second, None, &"x".repeat(8193)).await.0, 413);

    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    let (status, revoked) = owner(
        &f,
        "DELETE",
        &path,
        Some(json!({"expectedRevision":second["revision"]})),
    )
    .await;
    assert_eq!(status, 200, "{revoked}");
    assert_eq!(revoked["enabled"], false);
    assert_eq!(revoked.as_object().unwrap().len(), 2);
    assert_eq!(owner(&f, "GET", &path, None).await.1, revoked);
    assert_eq!(deliver(&f, &second, None, "{}").await.0, 401);
    f.close().await;
}

#[tokio::test]
async fn concurrent_delivery_starts_pi_once_and_replays_after_restart_without_retaining_payload() {
    let mut f = Fixture::new().await;
    let m = Model::new(Arc::new(|_| {
        Box::pin(async { finish("Synthetic webhook result.") })
    }))
    .await;
    assert_eq!(
        owner(&f, "PUT", &f.path("/settings"), Some(m.config()))
            .await
            .0,
        200
    );
    let r = routine(&f).await;
    let path = manage(&f, &r);
    let key = rotate(&f, &path, &json!("unset")).await;
    let marker = "Event data canary 7831";
    let body = json!({"text":marker,"instruction":"Untrusted event text"}).to_string();
    let (a, b) = tokio::join!(
        deliver(&f, &key, Some("event-A"), &body),
        deliver(&f, &key, Some("event-A"), &body)
    );
    assert_eq!(a.0, 202, "{}", a.2);
    assert_eq!(b.0, 202, "{}", b.2);
    assert_eq!(a.2["runId"], b.2["runId"]);
    assert_ne!(a.2["duplicate"], b.2["duplicate"]);
    let run = a.2["runId"].as_str().unwrap();
    let mismatched = deliver(&f, &key, Some("event-A"), "{}").await;
    assert_eq!(
        (mismatched.0, mismatched.2["code"].as_str()),
        (409, Some("ROUTINE_WEBHOOK_DUPLICATE_MISMATCH"))
    );
    let ws = store(&f).await;
    let messages = wait(&ws, |messages| {
        messages
            .iter()
            .any(|msg| msg["content"] == "Synthetic webhook result.")
    })
    .await;
    assert!(!json!(messages).to_string().contains(marker));
    let runs = f.path(&format!(
        "/routines/{}/runs/{run}",
        r["id"].as_str().unwrap()
    ));
    let (status, history) = owner(&f, "GET", &runs, None).await;
    assert_eq!(status, 200, "{history}");
    assert_eq!(history["trigger"], "webhook");
    assert_eq!(
        ws.get(Table::Routines, r["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["nextRunAt"],
        r["nextRunAt"]
    );
    assert!(!history.to_string().contains(marker));
    let sent = m.calls.lock().await;
    assert_eq!(sent.len(), 1);
    assert!(sent[0]["messages"].to_string().contains(marker));
    assert!(sent[0]["tools"].as_array().is_none_or(Vec::is_empty));
    drop(sent);
    let retained: (Option<String>, String) = sqlx::query_as(
        "SELECT idempotency_digest,payload_digest FROM routine_webhook_deliveries WHERE run_id=?",
    )
    .bind(run)
    .fetch_one(&ws.pool)
    .await
    .unwrap();
    assert_eq!(retained.0.unwrap().len(), 64);
    assert_eq!(retained.1.len(), 64);

    let edit = f.path(&format!("/routines/{}", r["id"].as_str().unwrap()));
    assert_eq!(
        owner(&f, "PATCH", &edit, Some(json!({"enabled":false})))
            .await
            .0,
        200
    );
    assert_eq!(
        deliver(&f, &key, Some("event-B"), "").await.2["code"],
        "ROUTINE_WEBHOOK_PAUSED"
    );
    assert_eq!(
        deliver(&f, &key, Some("event-A"), &body).await.2,
        json!({"runId":run,"duplicate":true})
    );
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    assert_eq!(
        deliver(&f, &key, Some("event-A"), &body).await.2,
        json!({"runId":run,"duplicate":true})
    );
    assert_eq!(m.calls.lock().await.len(), 1);
    f.close().await;
}

#[tokio::test]
async fn target_generation_and_durable_rate_limit_survive_key_rotation() {
    let f = Fixture::new().await;
    let mut r = routine(&f).await;
    let ws = store(&f).await;
    let id = "legacy_test-routine";
    r["id"] = json!(id);
    ws.put(Table::Routines, &r).await.unwrap();
    let path = manage(&f, &r);
    let first = rotate(&f, &path, &json!("unset")).await;
    assert!(first["path"].as_str().unwrap().ends_with(id));
    let mut changed = r.clone();
    changed["conversationId"] = json!(uuid::Uuid::new_v4().to_string());
    ws.put(Table::Routines, &changed).await.unwrap();
    ws.put(Table::Routines, &r).await.unwrap();
    assert_eq!(deliver(&f, &first, None, "").await.0, 401);
    assert_eq!(
        owner(&f, "GET", &path, None).await.1,
        json!({"enabled":false,"revision":first["revision"]})
    );

    let second = rotate(&f, &path, &first["revision"]).await;
    assert_eq!(
        deliver(&f, &second, None, "").await.2["code"],
        "ROUTINE_WEBHOOK_MODEL_UNAVAILABLE"
    );
    let at = chrono::Utc::now().timestamp_millis();
    for _ in 0..10 {
        sqlx::query("INSERT INTO routine_webhook_deliveries VALUES(?,?,?,NULL,'fixture',?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(id)
            .bind(second["revision"].as_str().unwrap())
            .bind(at)
            .execute(&ws.pool)
            .await
            .unwrap();
    }
    let third = rotate(&f, &path, &second["revision"]).await;
    let (status, headers, limited) = deliver(&f, &third, None, "").await;
    assert_eq!(
        (status, limited["code"].as_str()),
        (429, Some("ROUTINE_WEBHOOK_RATE_LIMIT"))
    );
    assert_eq!(headers["retry-after"], "60");

    ws.delete(Table::Routines, id).await.unwrap();
    ws.put(Table::Routines, &r).await.unwrap();
    assert_eq!(deliver(&f, &third, None, "").await.0, 401);
    let fourth = rotate(&f, &path, &third["revision"]).await;
    assert_eq!(
        deliver(&f, &fourth, None, "").await.2["code"],
        "ROUTINE_WEBHOOK_MODEL_UNAVAILABLE"
    );
    f.close().await;
}
