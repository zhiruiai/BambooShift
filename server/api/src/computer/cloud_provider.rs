use super::cloud_config::CloudBinding;
use crate::{
    db::{iso, now},
    error::{ApiError, Result},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::Duration;

pub async fn request(config: &CloudBinding, start: bool) -> Result<Value> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| unavailable())?;
    let url = format!(
        "{}/sandboxes/{}{}",
        config.api_base_url,
        config.sandbox_id,
        if start { "/connect" } else { "" }
    );
    let mut request = if start {
        client
            .post(url)
            .json(&json!({"timeout":7200}))
            .timeout(Duration::from_secs(90))
    } else {
        client.get(url).timeout(Duration::from_secs(8))
    };
    if let Some(key) = &config.api_key {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unavailable())?;
        if bytes.len() + chunk.len() > 128 * 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if value["sandboxID"] != config.sandbox_id
        || config
            .template_id
            .as_ref()
            .is_some_and(|id| value["templateID"] != *id)
    {
        return Err(ApiError::new(502, "云电脑身份与当前空间绑定不符。")
            .with_code("CLOUD_IDENTITY_MISMATCH"));
    }
    Ok(value)
}
pub async fn detail(config: &CloudBinding) -> Result<Value> {
    let value = request(config, false).await?;
    let state = value["state"]
        .as_str()
        .filter(|s| ["running", "paused", "pausing"].contains(s))
        .unwrap_or("unknown");
    if !value["endAt"].is_null()
        && !value["endAt"]
            .as_str()
            .is_some_and(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok())
    {
        return Err(unavailable());
    }
    Ok(json!({"state":state,"expiresAt":value["endAt"],"observedAt":iso(now())}))
}
pub fn unavailable() -> ApiError {
    ApiError::new(502, "云电脑服务暂时不可用，请刷新状态后重试。").with_code("CLOUD_UNAVAILABLE")
}
