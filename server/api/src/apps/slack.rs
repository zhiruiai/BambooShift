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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slack_rejects_bearer_alternative_paths_and_missing_setup() {
        let endpoint = "https://mcp.slack.com/mcp";
        let credentials = json!({"clientId": "synthetic-client", "clientSecret": "synthetic"});
        assert!(validate_endpoint(endpoint, "oauth").is_ok());
        assert!(validate_endpoint(endpoint, "bearer").is_err());
        assert!(validate_endpoint("https://mcp.slack.com./mcp", "oauth").is_err());
        assert!(validate_endpoint("https://mcp.slack.com/alternate", "oauth").is_err());
        assert!(validate_setup(endpoint, "http://127.0.0.1:3001", &credentials).is_err());
        assert!(validate_setup(endpoint, "https://openbot.example.test", &json!({})).is_err());
        assert!(validate_setup(endpoint, "https://openbot.example.test", &credentials).is_ok());
        assert!(validate_endpoint("https://mcp.example.test/mcp", "bearer").is_ok());
    }

    #[test]
    fn slack_refuses_to_use_preexisting_broad_or_unpinned_grants() {
        let endpoint = "https://mcp.slack.com/mcp";
        let grant = json!({
            "resource": policy()["resource"],
            "issuer": policy()["resource"],
            "metadata": {
                "authorization_endpoint": policy()["authorizationEndpoint"],
                "token_endpoint": policy()["tokenEndpoint"],
            },
            "scopes": ["search:read.public"],
        });
        assert!(validate_grant(endpoint, "oauth", &grant).is_ok());
        for scope in ["chat:write", "search:read.private", "search:read.im"] {
            let mut widened = grant.clone();
            widened["scopes"] = json!(["search:read.public", scope]);
            assert!(validate_grant(endpoint, "oauth", &widened).is_err());
        }
        let mut changed = grant;
        changed["metadata"]["token_endpoint"] = json!("https://other.example.test/token");
        assert!(validate_grant(endpoint, "oauth", &changed).is_err());
        assert!(validate_grant(endpoint, "bearer", &Value::Null).is_err());
    }
}
