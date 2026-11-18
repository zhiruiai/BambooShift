use super::*;

#[test]
fn summary_is_bounded_deduplicated_and_contains_no_provider_body() {
    let mut summary = empty();
    summary["searches"] = json!(9999);
    let rows = (0..20)
        .map(|n| {
            json!({"url":format!("https://example.com/{n}"),
            "title":format!("\u{202e}{}\u{0001}", "a".repeat(300)),"snippet":"PRIVATE_QUERY_BODY"})
        })
        .collect::<Vec<_>>();
    let output = Ok(json!({"results":rows,"reusedQuery":false}));
    merge(&mut summary, web_tools::SEARCH, &output);
    merge(&mut summary, web_tools::SEARCH, &output);
    assert_eq!(summary["searches"], 9999);
    assert_eq!(summary["sources"].as_array().unwrap().len(), 12);
    assert_eq!(summary["sources"][0]["title"].as_str().unwrap().len(), 240);
    assert!(!summary.to_string().contains("PRIVATE_QUERY_BODY"));
    source(
        &mut summary,
        &json!({"url":"https://example.com/0"}),
        "page",
    );
    assert_eq!(summary["sources"][0]["kind"], "page");
    assert_eq!(summary["sources"].as_array().unwrap().len(), 12);
    let error =
        Err(crate::error::ApiError::new(429, "RAW_SECRET").with_code("WEB_SEARCH_RATE_LIMITED"));
    merge(&mut summary, web_tools::SEARCH, &error);
    merge(&mut summary, web_tools::SEARCH, &error);
    assert_eq!(summary["issues"], json!(["upstream_rate_limit"]));
    assert!(!summary.to_string().contains("RAW_SECRET"));
    assert!(issue("WEB_FETCH_INVALID").is_none());
    assert!(issue("FORBIDDEN").is_none());
    let dns = Err(crate::error::ApiError::new(502, "DNS_PROVIDER_DETAIL")
        .with_code("WEB_FETCH_DNS_UNAVAILABLE"));
    merge(&mut summary, web_tools::FETCH, &dns);
    assert_eq!(
        summary["issues"],
        json!(["upstream_rate_limit", "unavailable"])
    );
    assert_eq!(summary["pagesRead"], 0);
    assert!(!summary.to_string().contains("DNS_PROVIDER_DETAIL"));
}

#[test]
fn titles_use_client_utf16_limits_and_urls_keep_the_public_result_policy() {
    let mut summary = empty();
    source(
        &mut summary,
        &json!({"url":"https://example.com/emoji","title":"😀".repeat(240)}),
        "search",
    );
    assert_eq!(
        summary["sources"][0]["title"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .count(),
        240
    );
    source(
        &mut summary,
        &json!({"url":"http://127.0.0.1/private","title":"Hidden"}),
        "search",
    );
    assert_eq!(summary["sources"].as_array().unwrap().len(), 1);
    source(
        &mut summary,
        &json!({"url":"https://example.com/fallback","title":"\u{202e}\u{0001}"}),
        "search",
    );
    assert_eq!(
        summary["sources"][1]["title"],
        "https://example.com/fallback"
    );
}
