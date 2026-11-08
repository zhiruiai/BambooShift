use super::exa_transport::{self, Failure, REQUEST_ID, Tool};
use crate::error::{ApiError, Result};
use serde::Serialize;
use serde_json::{Value, json};

#[path = "web_fetch_url.rs"]
mod url_policy;
pub(crate) use url_policy::validate_url;
pub(crate) const MAX_URL: usize = 2048;
pub(crate) const MIN_CHARACTERS: usize = 1000;
pub(crate) const MAX_CHARACTERS: usize = 20_000;
pub(crate) const DEFAULT_CHARACTERS: usize = 12_000;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchResult {
    pub title: String,
    /// The requested URL echoed by Exa, not a verified redirect destination.
    pub url: String,
    pub text: String,
    /// Exa does not report truncation; hitting the requested cap is only a hint.
    pub possibly_truncated: bool,
}
pub(crate) async fn fetch(url: &str, max_characters: usize) -> Result<FetchResult> {
    fetch_scoped(url, max_characters, None, None).await
}

pub(super) async fn fetch_scoped(
    url: &str,
    max_characters: usize,
    fixture: Option<&exa_transport::Fixture>,
    authorize: Option<&crate::apps::Authority>,
) -> Result<FetchResult> {
    let (url, request) = request(url, max_characters)?;
    // Only resolve here. OpenBot never opens a connection to the supplied URL.
    // Exa performs its own crawl; this check does not prove its redirect path.
    if fixture.is_none() {
        url_policy::check_dns(&url).await?;
    }
    if let Some(authorize) = authorize {
        authorize().await?;
    }
    let result = exa_transport::call_scoped(Tool::Fetch, request, fixture)
        .await
        .map_err(provider_error)?;
    document(&result, &url, max_characters)
}
fn request(url: &str, max_characters: usize) -> Result<(String, Value)> {
    let url = validate_url(url)?;
    if !(MIN_CHARACTERS..=MAX_CHARACTERS).contains(&max_characters) {
        return Err(invalid());
    }
    let request = json!({"jsonrpc":"2.0","id":REQUEST_ID,"method":"tools/call","params":{
        "name":Tool::Fetch.name(),"arguments":{"urls":[url],"maxCharacters":max_characters}
    }});
    Ok((url, request))
}
fn document(result: &Value, requested: &str, max_characters: usize) -> Result<FetchResult> {
    if result
        .get("structuredContent")
        .is_some_and(|v| !v.is_null())
    {
        return Err(bad_response());
    }
    let content = result["content"].as_array().ok_or_else(bad_response)?;
    let [block] = content.as_slice() else {
        return Err(bad_response());
    };
    if block["type"] != "text" {
        return Err(bad_response());
    }
    let text = block["text"].as_str().ok_or_else(bad_response)?;
    if text.trim() == "No content found for the provided URL(s)." {
        return Err(empty());
    }
    let text = text.replace("\r\n", "\n");
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(bad_response());
    }
    let (metadata, body) = text.split_once("\n\n").ok_or_else(bad_response)?;
    let mut lines = metadata.lines();
    let title = lines
        .next()
        .and_then(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .ok_or_else(bad_response)?;
    let echoed = lines
        .next()
        .and_then(|line| line.strip_prefix("URL: "))
        .ok_or_else(bad_response)?;
    if validate_url(echoed).map_err(|_| bad_response())? != requested {
        return Err(bad_response());
    }
    // The upstream formatter can add these two metadata fields before the body.
    // Unknown headers are not silently reclassified as extracted page content.
    let mut published = false;
    let mut author = false;
    for line in lines {
        if let Some(date) = line.strip_prefix("Published: ") {
            if published || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
                return Err(bad_response());
            }
            published = true;
        } else if let Some(name) = line.strip_prefix("Author: ") {
            if author || name.trim().is_empty() || name.len() > 1000 {
                return Err(bad_response());
            }
            author = true;
        } else {
            return Err(bad_response());
        }
    }
    let possibly_truncated = body.encode_utf16().count() >= max_characters;
    let body = body.trim();
    if body.is_empty() {
        return Err(empty());
    }
    if body
        .lines()
        .any(|line| line.starts_with(&format!("Error fetching {requested}: ")))
    {
        return Err(provider_error(Failure::ToolError));
    }
    let text = bounded(body, max_characters);
    Ok(FetchResult {
        title: bounded(title, 300),
        url: requested.into(),
        text,
        possibly_truncated,
    })
}
fn bounded(text: &str, max: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= max
        })
        .collect()
}
fn invalid() -> ApiError {
    ApiError::bad(
        "只能读取不含参数、片段或登录信息的公开 HTTP(S) 网址，并使用默认端口及有效的内容长度。",
    )
    .with_code("WEB_FETCH_INVALID")
}
fn empty() -> ApiError {
    ApiError::new(502, "网页服务没有返回可读取的正文。").with_code("WEB_FETCH_EMPTY")
}
fn bad_response() -> ApiError {
    ApiError::new(502, "网页服务返回了无法核验的内容。").with_code("WEB_FETCH_BAD_RESPONSE")
}
fn provider_error(error: Failure) -> ApiError {
    match error {
        Failure::Timeout => {
            ApiError::new(504, "公开网页读取超时，请稍后重试。").with_code("WEB_FETCH_TIMEOUT")
        }
        Failure::RateLimited => ApiError::new(429, "公开网页读取请求过多，请稍后重试。")
            .with_code("WEB_FETCH_RATE_LIMITED"),
        Failure::BadResponse => bad_response(),
        Failure::ToolError => {
            ApiError::new(502, "网页服务未能读取该公开网址。").with_code("WEB_FETCH_FAILED")
        }
        Failure::Unavailable => {
            ApiError::new(502, "公开网页读取服务暂不可用。").with_code("WEB_FETCH_UNAVAILABLE")
        }
    }
}

#[cfg(test)]
#[path = "web_fetch_tests.rs"]
mod tests;
