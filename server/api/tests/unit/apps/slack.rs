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
