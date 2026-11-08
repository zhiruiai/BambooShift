use super::*;
use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, Response},
    routing::post,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn example() -> Value {
    json!({"results":[
        {"title":"  Recent  Rust news ","url":"https://blog.rust-lang.org/news#intro",
         "text":"Read this excerpt.\nTitle: This is part of the same excerpt.","publishedDate":"2026-11-03T12:00:00Z"},
        {"title":"Duplicate fragment","url":"https://blog.rust-lang.org/news#footer"},
        {"title":"Nonpublic address","url":"http://127.0.0.1/admin"},
        {"title":"Local host","url":"http://printer.home.local/"},
        {"title":"Script","url":"javascript:alert(1)"},
        {"title":"Userinfo","url":"https://user:secret@rust-lang.org/"},
        {"title":"Docs","url":"https://doc.rust-lang.org/","highlights":["One", "Two"],"publishedDate":"Unknown"},
        {"title":"Extra result","url":"https://www.rust-lang.org/"}
    ]})
}

fn rpc(payload: &Value) -> Value {
    json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":payload.to_string()}]}})
}

#[test]
fn request_uses_only_the_trimmed_query_and_bounded_result_options() {
    assert_eq!(
        request("  近期 Rust 公告  ", 3).unwrap(),
        json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search_advanced_exa",
            "arguments":{"query":"近期 Rust 公告","numResults":3,"textMaxCharacters":600}}
        })
    );
    for (query, limit) in [
        ("", 1),
        ("search\0text", 1),
        ("valid", 0),
        ("valid", MAX_RESULTS + 1),
    ] {
        assert_eq!(
            request(query, limit).unwrap_err().code,
            "WEB_SEARCH_INVALID"
        );
    }
    assert!(request(&"😀".repeat(MAX_QUERY / 2 + 1), 1).is_err());
}

#[test]
fn structured_results_preserve_text_and_only_provider_publication_dates() {
    let results = results(&payload(rpc(&example())).unwrap(), 2).unwrap();
    assert_eq!(
        serde_json::to_value(&results).unwrap(),
        json!([
            {"title":"Recent Rust news","url":"https://blog.rust-lang.org/news",
             "snippet":"Read this excerpt. Title: This is part of the same excerpt.","publishedAt":"2026-11-03T12:00:00Z"},
            {"title":"Docs","url":"https://doc.rust-lang.org/","snippet":"One Two"}
        ])
    );
    assert_eq!(publication_date("2026-11-03"), Some("2026-11-03".into()));
    assert_eq!(publication_date("2026-11-31"), None);
    assert_eq!(publication_date("2026-11"), None);
    assert_eq!(
        clean_text(&"中".repeat(700), MAX_SNIPPET).chars().count(),
        MAX_SNIPPET
    );
}

#[test]
fn public_results_with_missing_titles_still_preserve_sources_and_excerpts() {
    let rows = json!({"results":[
        {"title":"  ", "url":"https://react.dev/reference/react/useEffect#intro", "text":"Read the official guide."},
        {"title":null, "url":"https://react.dev/reference/react/useEffect#footer"},
        {"url":"https://react.dev/learn"},
        {"title":"Private", "url":"http://127.0.0.1/admin"}
    ]});
    let items = results(&rows, 4).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].title, "react.dev/reference/react/useEffect");
    assert_eq!(items[0].url, "https://react.dev/reference/react/useEffect");
    assert_eq!(items[0].snippet, "Read the official guide.");
    assert_eq!(items[1].title, "react.dev/learn");
}

#[test]
fn sse_requires_matching_rpc_response_and_rejects_errors() {
    let body = format!(
        ": ping\r\nevent: message\r\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\r\n\r\nevent: message\r\ndata: {}\r\n\r\n",
        rpc(&example())
    );
    assert_eq!(
        payload(sse_reply(body.as_bytes()).unwrap()).unwrap(),
        example()
    );
    assert!(sse_reply(b"data: {\"jsonrpc\":\"2.0\",\"id\":2}\n\n").is_err());
    assert!(
        payload(json!({"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[]}})).is_err()
    );
    assert!(payload(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32603}})).is_err());
    assert!(payload(json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Title: fabricated\nURL: https://rust-lang.org"}]}})).is_err());
    assert!(
        results(
            &json!({"results":[{"title":"Unsafe","url":"file:///etc/passwd"}]}),
            1
        )
        .is_err()
    );
    assert!(results(&json!({"results":[]}), 1).unwrap().is_empty());
}

async fn fixture(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (endpoint, task)
}

#[tokio::test]
async fn http_sends_no_credentials_and_accepts_json_and_sse() {
    let check = |headers: &HeaderMap, value: &Value| {
        for name in [
            "authorization",
            "proxy-authorization",
            "cookie",
            "x-api-key",
        ] {
            assert!(!headers.contains_key(name));
        }
        assert_eq!(
            headers[header::ACCEPT],
            "application/json, text/event-stream"
        );
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        assert_eq!(value, &request("synthetic lookup", 1).unwrap());
    };
    let router = Router::new()
        .route(
            "/sse",
            post(
                move |headers: HeaderMap, Json(value): Json<Value>| async move {
                    check(&headers, &value);
                    Response::builder()
                        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
                        .header(header::SET_COOKIE, "remote=ignored; Path=/")
                        .body(Body::from(format!(
                            "event: message\ndata: {}\n\n",
                            rpc(&example())
                        )))
                        .unwrap()
                },
            ),
        )
        .route(
            "/json",
            post(
                move |headers: HeaderMap, Json(value): Json<Value>| async move {
                    check(&headers, &value);
                    Json(json!({"jsonrpc":"2.0","id":1,"result":{"structuredContent":example()}}))
                },
            ),
        );
    let (base, server) = fixture(router).await;
    let client = client_builder().build().unwrap();
    for path in ["sse", "json"] {
        let results = execute(
            &client,
            &format!("{base}/{path}"),
            request("synthetic lookup", 1).unwrap(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://blog.rust-lang.org/news");
    }
    server.abort();
}

#[tokio::test]
async fn http_rejects_redirects_rate_limits_oversized_streams_and_timeouts() {
    let followed = Arc::new(AtomicUsize::new(0));
    let count = followed.clone();
    let router = Router::new()
        .route(
            "/redirect",
            post(|| async {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [(header::LOCATION, "/target")],
                )
            }),
        )
        .route(
            "/target",
            post(move || {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::Relaxed);
                    Json(rpc(&example()))
                }
            }),
        )
        .route("/limit", post(|| async { StatusCode::TOO_MANY_REQUESTS }))
        .route(
            "/oversized",
            post(|| async {
                let chunks = futures_util::stream::iter(
                    [vec![b' '; MAX_BODY], vec![b' '; 1]].map(Ok::<_, std::io::Error>),
                );
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from_stream(chunks))
                    .unwrap()
            }),
        )
        .route(
            "/stall",
            post(|| async {
                let chunks =
                    futures_util::stream::pending::<std::result::Result<Vec<u8>, std::io::Error>>();
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from_stream(chunks))
                    .unwrap()
            }),
        );
    let (base, server) = fixture(router).await;
    let client = client_builder().build().unwrap();
    for (path, code) in [
        ("redirect", "WEB_SEARCH_UNAVAILABLE"),
        ("limit", "WEB_SEARCH_RATE_LIMITED"),
        ("oversized", "WEB_SEARCH_BAD_RESPONSE"),
    ] {
        let error = execute(
            &client,
            &format!("{base}/{path}"),
            request("synthetic lookup", 1).unwrap(),
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, code);
    }
    let short = client_builder()
        .timeout(Duration::from_millis(200))
        .build()
        .unwrap();
    let error = execute(
        &short,
        &format!("{base}/stall"),
        request("synthetic lookup", 1).unwrap(),
        1,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "WEB_SEARCH_TIMEOUT");
    assert_eq!(followed.load(Ordering::Relaxed), 0);
    server.abort();
}

#[tokio::test]
#[ignore = "Requires anonymous access to Exa's live public search endpoint"]
async fn live_public_search_returns_a_usable_source() {
    let results = search(
        "Rust programming language official stable release blog site:blog.rust-lang.org",
        2,
    )
    .await
    .unwrap();
    assert!(!results.is_empty());
    assert!(
        results
            .iter()
            .all(|result| !result.title.is_empty() && !result.snippet.is_empty())
    );
    assert!(results.iter().any(|result| {
        Url::parse(&result.url)
            .unwrap()
            .host_str()
            .is_some_and(|host| host == "rust-lang.org" || host.ends_with(".rust-lang.org"))
    }));
    eprintln!("Exa returned {} usable public Rust sources", results.len());
}
