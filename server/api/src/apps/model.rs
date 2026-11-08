use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub url: String,
    pub revision: String,
    pub auth_type: String,
    pub status: String,
    pub tools: Vec<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) tool_controls: BTreeMap<String, super::tool_access::Control>,
    #[serde(default)]
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revocation: Option<String>,
    #[serde(default)]
    pub refreshing: bool,
    #[serde(default, rename = "token", skip_serializing)]
    pub(crate) legacy_token: Option<String>,
    #[serde(default, rename = "oauth", skip_serializing)]
    pub(crate) legacy_grant: Option<Value>,
}
impl Connection {
    pub fn public(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap();
        let map = value.as_object_mut().unwrap();
        map.remove("tools");
        map.remove("toolControls");
        map.remove("credentialRef");
        map.remove("refreshing");
        map.insert(
            "hasCredential".into(),
            json!(
                self.credential_ref.is_some()
                    || self.legacy_token.is_some()
                    || self.legacy_grant.is_some()
            ),
        );
        map.insert("toolCount".into(), json!(self.tools.len()));
        map.insert("toolAccessSupported".into(), Value::Bool(true));
        value
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedCall {
    pub connection_id: String,
    pub connection_revision: String,
    pub app_name: String,
    pub tool_name: String,
    pub arguments: Value,
    pub schema_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_access_revision: Option<String>,
    pub tool: Value,
    #[serde(skip)]
    pub(crate) expected_catalog: Option<Vec<Value>>,
}
impl PreparedCall {
    pub(super) fn matches(&self, other: &Self) -> bool {
        self.connection_id == other.connection_id
            && self.connection_revision == other.connection_revision
            && self.tool_name == other.tool_name
            && self.schema_hash == other.schema_hash
            && self.tool_access_revision == other.tool_access_revision
    }
}
pub fn hash(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string()))
}
pub fn secret(value: &Value, max: usize) -> Result<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && s.bytes().all(|b| (33..=126).contains(&b)))
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad("请输入有效的访问凭据，不要包含空格或换行。"))
}
pub fn object(value: &Value, maximum: usize) -> Result<Value> {
    fn valid(value: &Value, depth: usize) -> bool {
        if depth > 20 {
            return false;
        }
        match value {
            Value::Object(map) => map.iter().all(|(k, v)| {
                !["__proto__", "prototype", "constructor"].contains(&k.as_str())
                    && valid(v, depth + 1)
            }),
            Value::Array(items) => items.iter().all(|v| valid(v, depth + 1)),
            _ => true,
        }
    }
    if !value.is_object() || value.to_string().len() > maximum || !valid(value, 0) {
        return Err(ApiError::bad("应用参数格式无效或过长。"));
    }
    Ok(value.clone())
}
pub fn catalog(value: Value, secrets: &[String]) -> Result<Vec<Value>> {
    let tools = value
        .as_array()
        .filter(|a| a.len() <= 64)
        .ok_or_else(|| ApiError::bad("应用工具列表过大。"))?;
    let mut names = std::collections::HashSet::new();
    for tool in tools {
        let name = tool["name"].as_str().unwrap_or("");
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:/-".contains(&b))
            || !names.insert(name)
        {
            return Err(ApiError::bad("应用返回了无效的工具列表。"));
        }
        if tool["description"]
            .as_str()
            .is_none_or(|s| s.chars().count() > 4000)
            || tool["inputSchema"]["type"] != "object"
        {
            return Err(ApiError::bad("应用工具参数格式不受支持。"));
        }
        object(&tool["inputSchema"], 16384)?;
    }
    let text = value.to_string();
    if text.len() > 512 * 1024 || secrets.iter().any(|s| !s.is_empty() && text.contains(s)) {
        return Err(ApiError::bad("应用返回了无效的工具信息。"));
    }
    Ok(tools.clone())
}
pub fn redact(mut text: String, secrets: &[String]) -> String {
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        let encoded = serde_json::to_string(secret).unwrap();
        text = text
            .replace(&encoded[1..encoded.len() - 1], "[凭据已隐藏]")
            .replace(secret, "[凭据已隐藏]");
    }
    text
}
pub const UNKNOWN: &str = "外部操作可能已执行，结果未知；请先核对，不要自动重试。";
