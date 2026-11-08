use super::*;
use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, Response, StatusCode, header},
    routing::post,
};
use std::{net::IpAddr, time::Duration};

fn content(text: &str) -> Value {
    json!({"content":[{"type":"text","text":text,"_meta":{"searchTime":0.1}}]})
}
fn rpc(result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":1,"result":result})
}
fn page(body: &str) -> Value {
    content(&format!(
        "# Public Rust guide\nURL: https://doc.rust-lang.org/book/\n\n{body}\n"
    ))
}
#[test]
fn request_normalizes_one_public_url_and_rejects_private_or_credential_bearing_urls() {
    let (url, value) = request("HTTPS://DOC.RUST-LANG.ORG:443/book/", 1000).unwrap();
    assert_eq!(url, "https://doc.rust-lang.org/book/");
    assert_eq!(
        value,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
            "name":"web_fetch_exa","arguments":{"urls":[url],"maxCharacters":1000}
        }})
    );
    for raw in [
        "",
        "https://rust-lang.org/?token=private",
        "https://rust-lang.org/?",
        "https://rust-lang.org/#fragment",
        "https://u:p@rust-lang.org/",
        "https://rust-lang.org:8443/",
        "http://127.0.0.1/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://printer/",
        "http://printer.home/",
        "http://a.local/",
        "http://a.internal/",
        "http://a.test/",
        "http://metadata.google.internal/",
        "http://localhost.example.com/",
        "https://a.onion/",
        "https://a.arpa/",
        "https://a.example/",
        "https://a.corp/",
        "https://a.alt/",
        "https://rust-lang.org./",
        "https://-a.com/",
        "https://rust-lang.org/\nsecret",
        " https://rust-lang.org/",
        "https://rust-lang.org\\@127.0.0.1/",
        "file:///etc/passwd",
    ] {
        assert_eq!(
            request(raw, 1000).unwrap_err().code,
            "WEB_FETCH_INVALID",
            "{raw}"
        );
    }
    assert!(request("https://rust-lang.org/", MIN_CHARACTERS - 1).is_err());
    assert!(request("https://rust-lang.org/", MAX_CHARACTERS + 1).is_err());
}
#[test]
fn dns_preflight_requires_every_resolved_address_to_be_public() {
    let address = |s: &str| s.parse::<IpAddr>().unwrap();
    for ip in [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.31.1.1",
        "192.168.1.1",
        "192.0.0.1",
        "192.0.2.1",
        "192.88.99.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "2002:7f00:1::",
        "3fff::1",
    ] {
        assert!(
            url_policy::validate_addresses(&[address("1.1.1.1"), address(ip)]).is_err(),
            "{ip}"
        );
    }
    assert!(url_policy::validate_addresses(&[]).is_err());
    assert!(
        url_policy::validate_addresses(&[address("1.1.1.1"), address("2606:4700:4700::1111")])
            .is_ok()
    );
}
#[test]
fn document_preserves_markdown_and_binds_only_the_requested_url_not_a_redirect_destination() {
    let text = "# Public Rust guide\r\nURL: https://doc.rust-lang.org/book/\r\nPublished: 2026-11-01\r\nAuthor: Public author\r\n\r\n## Intro\r\n\r\n- First\r\n- 第二项\r\n";
    let result = document(&content(text), "https://doc.rust-lang.org/book/", 1000).unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({"title":"Public Rust guide","url":"https://doc.rust-lang.org/book/","text":"## Intro\n\n- First\n- 第二项","possiblyTruncated":false})
    );
    for mismatch in [
        "https://doc.rust-lang.org/other/",
        "https://other.example.com/book/",
        "http://doc.rust-lang.org/book/",
    ] {
        assert_eq!(
            document(&page("Actual text"), mismatch, 1000)
                .unwrap_err()
                .code,
            "WEB_FETCH_BAD_RESPONSE"
        );
    }
}
#[test]
fn malformed_empty_error_and_ambiguous_payloads_are_never_readable_documents() {
    for text in [
        "",
        "No content found for the provided URL(s).",
        "# Guide\nURL: https://doc.rust-lang.org/book/\n\n ",
    ] {
        assert!(document(&content(text), "https://doc.rust-lang.org/book/", 1000).is_err());
    }
    for text in [
        "# Guide\n\nnot a source",
        "# Guide\nURL: http://localhost/\n\ntext",
        "# Guide\nURL: https://doc.rust-lang.org/book/\nUnknown: something\n\ntext",
        "# Guide\nURL: https://doc.rust-lang.org/book/\nPublished: yesterday\n\ntext",
        "# Guide\nURL: https://doc.rust-lang.org/book/\n\ntext\0secret",
    ] {
        assert_eq!(
            document(&content(text), "https://doc.rust-lang.org/book/", 1000)
                .unwrap_err()
                .code,
            "WEB_FETCH_BAD_RESPONSE"
        );
    }
    let mut two = page("text");
    two["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"text","text":"another source"}));
    assert!(document(&two, "https://doc.rust-lang.org/book/", 1000).is_err());
    let error=exa_transport::payload(rpc(json!({"isError":true,"content":[{"type":"text","text":"Error fetching URL(s): CRAWL_NOT_FOUND"}]}))).unwrap_err();
    assert_eq!(provider_error(error).code, "WEB_FETCH_FAILED");
    assert_eq!(
        document(
            &page("text\n\nError fetching https://doc.rust-lang.org/book/: CRAWL_NOT_FOUND"),
            "https://doc.rust-lang.org/book/",
            1000
        )
        .unwrap_err()
        .code,
        "WEB_FETCH_FAILED"
    );
}
#[test]
fn returned_body_is_bounded_in_utf16_without_claiming_it_is_complete() {
    let source = format!("{}😀trailing", "x".repeat(999));
    let result = document(&page(&source), "https://doc.rust-lang.org/book/", 1000).unwrap();
    assert_eq!(result.text, "x".repeat(999));
    assert!(result.possibly_truncated);
    assert!(
        document(
            &page(&"x".repeat(1000)),
            "https://doc.rust-lang.org/book/",
            1000
        )
        .unwrap()
        .possibly_truncated
    );
    assert!(
        document(
            &page(&format!("{}   ", "x".repeat(997))),
            "https://doc.rust-lang.org/book/",
            1000
        )
        .unwrap()
        .possibly_truncated
    );
    assert!(
        !document(
            &page("short extract"),
            "https://doc.rust-lang.org/book/",
            1000
        )
        .unwrap()
        .possibly_truncated
    );
}
async fn fixture(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, task)
}
#[tokio::test]
async fn shared_http_transport_sends_only_one_requested_url_and_accepts_exa_text_sse() {
    let router = Router::new().route(
        "/",
        post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            for key in [
                "authorization",
                "cookie",
                "proxy-authorization",
                "x-api-key",
            ] {
                assert!(!headers.contains_key(key));
            }
            assert_eq!(
                body,
                request("https://doc.rust-lang.org/book/", 1000).unwrap().1
            );
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
                .body(Body::from(format!(
                    ": ping\r\nevent: message\r\ndata: {}\r\n\r\n",
                    rpc(page("Real fixture paragraph."))
                )))
                .unwrap()
        }),
    );
    let (endpoint, server) = fixture(router).await;
    let (url, request) = request("https://doc.rust-lang.org/book/", 1000).unwrap();
    let value = exa_transport::execute(
        &exa_transport::client_builder().build().unwrap(),
        &endpoint,
        request,
    )
    .await
    .unwrap();
    assert_eq!(
        document(&value, &url, 1000).unwrap().text,
        "Real fixture paragraph."
    );
    server.abort();
}
#[tokio::test]
async fn shared_transport_distinguishes_fetch_failure_rate_limit_timeout_and_conflicting_replies() {
    let router = Router::new()
        .route(
            "/failed",
            post(|| async {
                Json(rpc(
                    json!({"isError":true,"content":[{"type":"text","text":"CRAWL_NOT_FOUND"}]}),
                ))
            }),
        )
        .route("/limit", post(|| async { StatusCode::TOO_MANY_REQUESTS }))
        .route(
            "/conflict",
            post(|| async {
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(format!(
                        "data: {}\n\ndata: {}\n\n",
                        rpc(page("first")),
                        rpc(page("second"))
                    )))
                    .unwrap()
            }),
        )
        .route(
            "/stall",
            post(|| async {
                let stream =
                    futures_util::stream::pending::<std::result::Result<Vec<u8>, std::io::Error>>();
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }),
        );
    let (endpoint, server) = fixture(router).await;
    let client = exa_transport::client_builder()
        .timeout(Duration::from_millis(200))
        .build()
        .unwrap();
    for (path, code) in [
        ("failed", "WEB_FETCH_FAILED"),
        ("limit", "WEB_FETCH_RATE_LIMITED"),
        ("conflict", "WEB_FETCH_BAD_RESPONSE"),
        ("stall", "WEB_FETCH_TIMEOUT"),
    ] {
        let (_, request) = request("https://doc.rust-lang.org/book/", 1000).unwrap();
        let error = exa_transport::execute(&client, &format!("{endpoint}/{path}"), request)
            .await
            .unwrap_err();
        assert_eq!(provider_error(error).code, code);
    }
    server.abort();
}
#[tokio::test]
#[ignore = "Requires anonymous access to Exa's live public fetch endpoint"]
async fn live_public_fetch_returns_a_verified_requested_url_and_nonempty_excerpt() {
    let result = fetch("https://doc.rust-lang.org/book/", 2000)
        .await
        .unwrap();
    assert_eq!(result.url, "https://doc.rust-lang.org/book/");
    assert!(!result.title.is_empty() && !result.text.is_empty());
    assert!(result.text.encode_utf16().count() <= 2000);
    eprintln!(
        "Exa returned {} characters of public Rust documentation",
        result.text.chars().count()
    );
}
