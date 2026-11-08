use super::exa_transport::{self, Failure, REQUEST_ID, Tool};
use crate::error::{ApiError, Result};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use url::{Host, Url};
#[cfg(test)]
use {
    super::exa_transport::{MAX_BODY, client_builder, sse_reply},
    reqwest::{Client, StatusCode, header},
    std::time::Duration,
};

const TOOL: &str = "web_search_advanced_exa";
const MAX_SNIPPET: usize = 600;
const MAX_TITLE: usize = 200;
const MAX_URL: usize = 2048;
pub(crate) const MAX_QUERY: usize = 400;
pub(crate) const MAX_RESULTS: usize = 5;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

pub(crate) async fn search(query: &str, limit: usize) -> Result<Vec<SearchResult>> {
    search_scoped(query, limit, None).await
}

pub(super) async fn search_scoped(
    query: &str,
    limit: usize,
    fixture: Option<&exa_transport::Fixture>,
) -> Result<Vec<SearchResult>> {
    let request = request(query, limit)?;
    let result = exa_transport::call_scoped(Tool::Search, request, fixture)
        .await
        .map_err(provider_error)?;
    results(&search_payload(result)?, limit)
}

pub(super) fn validate_query(query: &str) -> Result<()> {
    if query.is_empty()
        || query.encode_utf16().count() > MAX_QUERY
        || query.chars().any(char::is_control)
    {
        return Err(ApiError::bad("搜索查询无效。").with_code("WEB_SEARCH_INVALID"));
    }
    Ok(())
}

fn request(query: &str, limit: usize) -> Result<Value> {
    let query = query.trim();
    validate_query(query)?;
    if !(1..=MAX_RESULTS).contains(&limit) {
        return Err(ApiError::bad("搜索结果数量无效。").with_code("WEB_SEARCH_INVALID"));
    }
    // The hosted endpoint accepts a stateless Streamable HTTP tool call.
    Ok(
        json!({"jsonrpc":"2.0","id":REQUEST_ID,"method":"tools/call","params":{
            "name":TOOL,"arguments":{"query":query,"numResults":limit,"textMaxCharacters":MAX_SNIPPET}
        }}),
    )
}

#[cfg(test)]
async fn execute(
    client: &Client,
    endpoint: &str,
    request: Value,
    limit: usize,
) -> Result<Vec<SearchResult>> {
    let result = exa_transport::execute(client, endpoint, request)
        .await
        .map_err(provider_error)?;
    results(&search_payload(result)?, limit)
}
#[cfg(test)]
fn payload(message: Value) -> Result<Value> {
    search_payload(exa_transport::payload(message).map_err(provider_error)?)
}
fn search_payload(mut result: Value) -> Result<Value> {
    if let Some(structured) = result.get_mut("structuredContent") {
        if !structured.is_null() {
            return Ok(structured.take());
        }
    }
    let content = result["content"].as_array().ok_or_else(bad_response)?;
    let [block] = content.as_slice() else {
        return Err(bad_response());
    };
    if block["type"] != "text" {
        return Err(bad_response());
    }
    let text = block["text"].as_str().ok_or_else(bad_response)?;
    serde_json::from_str(text).map_err(|_| bad_response())
}

fn clean_text(raw: &str, max: usize) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max)
        .collect()
}

pub(super) fn public_url(raw: &str) -> Option<String> {
    if raw.len() > MAX_URL || raw.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    let Host::Domain(host) = url.host()? else {
        return None;
    };
    let host = host.trim_end_matches('.');
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !host.contains('.')
        || [".localhost", ".local", ".internal", ".test", ".invalid"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return None;
    }
    url.set_fragment(None);
    let url = url.to_string();
    (url.len() <= MAX_URL).then_some(url)
}

fn publication_date(raw: &str) -> Option<String> {
    let raw = raw.trim();
    (raw.len() <= 40
        && (chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").is_ok()
            || chrono::DateTime::parse_from_rfc3339(raw).is_ok()))
    .then(|| raw.to_owned())
}

fn results(payload: &Value, limit: usize) -> Result<Vec<SearchResult>> {
    let rows = payload["results"].as_array().ok_or_else(bad_response)?;
    let mut seen = HashSet::new();
    let output: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            let url = public_url(row["url"].as_str()?)?;
            if !seen.insert(url.clone()) {
                return None;
            }
            let title = clean_text(row["title"].as_str().unwrap_or_default(), MAX_TITLE);
            let title = if title.is_empty() {
                clean_text(
                    url.split_once("://")
                        .map_or(url.as_str(), |(_, label)| label),
                    MAX_TITLE,
                )
            } else {
                title
            };
            let text = row["text"].as_str().unwrap_or("");
            let snippet = if text.trim().is_empty() {
                let excerpts = row["highlights"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
                clean_text(&excerpts, MAX_SNIPPET)
            } else {
                clean_text(text, MAX_SNIPPET)
            };
            Some(SearchResult {
                title,
                url,
                snippet,
                published_at: row["publishedDate"].as_str().and_then(publication_date),
            })
        })
        .take(limit)
        .collect();
    if !rows.is_empty() && output.is_empty() {
        return Err(bad_response());
    }
    Ok(output)
}

fn provider_error(error: Failure) -> ApiError {
    match error {
        Failure::Timeout => {
            ApiError::new(504, "公网搜索超时，请稍后重试。").with_code("WEB_SEARCH_TIMEOUT")
        }
        Failure::RateLimited => ApiError::new(429, "上游公网搜索服务暂时限流，请稍后重试。")
            .with_code("WEB_SEARCH_RATE_LIMITED"),
        Failure::BadResponse => bad_response(),
        Failure::Unavailable | Failure::ToolError => unavailable(),
    }
}

fn unavailable() -> ApiError {
    ApiError::new(502, "公网搜索服务暂不可用。").with_code("WEB_SEARCH_UNAVAILABLE")
}

fn bad_response() -> ApiError {
    ApiError::new(502, "公网搜索服务返回了无效响应。").with_code("WEB_SEARCH_BAD_RESPONSE")
}

#[cfg(test)]
#[path = "web_search_tests.rs"]
mod tests;
