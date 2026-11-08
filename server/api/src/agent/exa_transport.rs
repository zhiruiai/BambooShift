use reqwest::{Client, Response, StatusCode, header, redirect::Policy};
use serde_json::Value;
use std::{net::IpAddr, sync::OnceLock, time::Duration};

pub(super) const REQUEST_ID: u64 = 1;
pub(super) const MAX_BODY: usize = 256 * 1024;
static CLIENT: OnceLock<std::result::Result<Client, reqwest::Error>> = OnceLock::new();

#[derive(Clone, Copy)]
pub(super) enum Tool {
    Search,
    Fetch,
}
impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Self::Search => "web_search_advanced_exa",
            Self::Fetch => "web_fetch_exa",
        }
    }
    fn endpoint(self) -> &'static str {
        match self {
            Self::Search => "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa",
            Self::Fetch => "https://mcp.exa.ai/mcp?tools=web_fetch_exa",
        }
    }
}
#[derive(Debug)]
pub(super) enum Failure {
    Unavailable,
    Timeout,
    RateLimited,
    BadResponse,
    ToolError,
}
pub(super) fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .local_address(IpAddr::from([0, 0, 0, 0]))
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(15))
        .pool_max_idle_per_host(2)
}
pub(super) struct Fixture {
    client: Client,
    origin: String,
}

impl Fixture {
    pub(super) fn new(origin: &str) -> crate::error::Result<Self> {
        let invalid = || crate::error::ApiError::bad("Invalid public web fixture origin");
        let url = url::Url::parse(origin).map_err(|_| invalid())?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.port().is_some_and(|port| port > 0)
            || url.origin().ascii_serialization() != origin
        {
            return Err(invalid());
        }
        Ok(Self {
            client: client_builder().build().map_err(|_| invalid())?,
            origin: origin.to_owned(),
        })
    }
}

pub(super) async fn call_scoped(
    tool: Tool,
    request: Value,
    fixture: Option<&Fixture>,
) -> Result<Value, Failure> {
    if request["params"]["name"] != tool.name() {
        return Err(Failure::BadResponse);
    }
    if let Some(fixture) = fixture {
        let url = format!("{}/mcp?tools={}", fixture.origin, tool.name());
        return execute(&fixture.client, &url, request).await;
    }
    let client = CLIENT
        .get_or_init(|| client_builder().https_only(true).build())
        .as_ref()
        .map_err(|_| Failure::Unavailable)?;
    execute(client, tool.endpoint(), request).await
}
// Only provider tests can substitute a loopback fixture endpoint. Production
// callers select one of the fixed tools above, never a user-controlled URL.
pub(super) async fn execute(
    client: &Client,
    endpoint: &str,
    request: Value,
) -> Result<Value, Failure> {
    let response = client
        .post(endpoint)
        .header(header::ACCEPT, "application/json, text/event-stream")
        .json(&request)
        .send()
        .await
        .map_err(network_error)?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err(Failure::RateLimited);
    }
    if response.status() != StatusCode::OK {
        return Err(Failure::Unavailable);
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .ok_or(Failure::BadResponse)?;
    if !["application/json", "text/event-stream"].contains(&content_type.as_str()) {
        return Err(Failure::BadResponse);
    }
    let body = read_body(response).await?;
    let message = if content_type == "text/event-stream" {
        sse_reply(&body)?
    } else {
        serde_json::from_slice(&body).map_err(|_| Failure::BadResponse)?
    };
    payload(message)
}
async fn read_body(mut response: Response) -> Result<Vec<u8>, Failure> {
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(Failure::BadResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > MAX_BODY - bytes.len() {
            return Err(Failure::BadResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub(super) fn sse_reply(body: &[u8]) -> Result<Value, Failure> {
    let text = std::str::from_utf8(body).map_err(|_| Failure::BadResponse)?;
    let mut data = String::new();
    let mut reply = None;
    for line in text.lines().chain(std::iter::once("")) {
        if line.is_empty() && !data.is_empty() {
            let event: Value = serde_json::from_str(&data).map_err(|_| Failure::BadResponse)?;
            if event["id"] == REQUEST_ID && reply.replace(event).is_some() {
                return Err(Failure::BadResponse);
            }
            data.clear();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
            data.push('\n');
        }
    }
    reply.ok_or(Failure::BadResponse)
}
pub(super) fn payload(mut message: Value) -> Result<Value, Failure> {
    if message["jsonrpc"] != "2.0" || message["id"] != REQUEST_ID {
        return Err(Failure::BadResponse);
    }
    if message.get("error").is_some() {
        return Err(Failure::Unavailable);
    }
    let result = &mut message["result"];
    if !result.is_object() || result.get("isError").is_some_and(|v| !v.is_boolean()) {
        return Err(Failure::BadResponse);
    }
    if result["isError"] == true {
        return Err(Failure::ToolError);
    }
    Ok(result.take())
}
fn network_error(error: reqwest::Error) -> Failure {
    if error.is_timeout() {
        Failure::Timeout
    } else {
        Failure::Unavailable
    }
}
