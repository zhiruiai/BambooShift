use crate::error::{ApiError, Result};
use serde_json::Value;
use std::sync::OnceLock;

fn policy() -> &'static Value {
    static POLICY: OnceLock<Value> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../shared/slack-mcp.json"))
            .expect("The checked-in Slack policy is valid")
    })
}

fn is_slack(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| {
        url.host_str()
            .is_some_and(|host| host.trim_end_matches('.') == "mcp.slack.com")
    })
}

fn exact_endpoint(url: &str) -> bool {
    policy()["endpoint"].as_str() == Some(url)
}

pub fn validate_endpoint(url: &str, auth_type: &str) -> Result<()> {
    if is_slack(url) && (!exact_endpoint(url) || auth_type != "oauth") {
        return Err(
            ApiError::bad("Slack 连接须使用官方 MCP 地址和网页登录授权。")
                .with_code("SLACK_OAUTH_SETUP"),
        );
    }
    Ok(())
}

pub fn validate_setup(url: &str, origin: &str, body: &Value) -> Result<()> {
    if !is_slack(url) {
        return Ok(());
    }
    validate_endpoint(url, "oauth")?;
    if body.get("scope").is_some() {
        return Err(ApiError::bad("Slack 使用固定的只读授权范围。").with_code("SLACK_OAUTH_SETUP"));
    }
    if !origin.starts_with("https://")
        || body["clientId"].as_str().is_none_or(str::is_empty)
        || body["clientSecret"].as_str().is_none_or(str::is_empty)
    {
        return Err(
            ApiError::bad("Slack 需要 HTTPS 回调和已登记的 Client ID、Client Secret。")
                .with_code("SLACK_OAUTH_SETUP"),
        );
    }
    Ok(())
}

pub fn validate_grant(url: &str, auth_type: &str, grant: &Value) -> Result<()> {
    if !is_slack(url) {
        return Ok(());
    }
    let policy = policy();
    let allowed = policy["scopes"]
        .as_array()
        .expect("Slack scopes are a list");
    let resource = policy["resource"]
        .as_str()
        .expect("Slack resource is a URL");
    let correct_resource = |key: &str| {
        grant[key]
            .as_str()
            .is_some_and(|value| value == resource || value.strip_suffix('/') == Some(resource))
    };
    if !exact_endpoint(url)
        || auth_type != "oauth"
        || !correct_resource("resource")
        || !correct_resource("issuer")
        || grant["metadata"]["authorization_endpoint"] != policy["authorizationEndpoint"]
        || grant["metadata"]["token_endpoint"] != policy["tokenEndpoint"]
        || !grant["scopes"].as_array().is_some_and(|scopes| {
            !scopes.is_empty()
                && scopes.len() <= allowed.len()
                && scopes.iter().all(|s| allowed.contains(s))
        })
    {
        return Err(ApiError::new(409, "请为 Slack 重新完成只读网页登录授权。")
            .with_code("APP_AUTH_REQUIRED"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/unit/apps/slack.rs"]
mod tests;
