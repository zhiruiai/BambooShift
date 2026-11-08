use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PROTOCOL: &str = "openbot-computer-v2";
pub const CLEANUP: &str = "operation-cleanup-v1";
pub const SCREEN_POOL: &str = "screen-pool-v1";
pub const LIFECYCLE: &str = "screen-lifecycle-v1";
pub const PRIVATE_TAKEOVER: &str = "private-takeover-frames-v1";
pub const MAX_FILE: usize = 10 * 1024 * 1024;
pub const MAX_RESPONSE: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSession {
    pub id: String,
    pub generation: String,
}
impl DesktopSession {
    pub fn parse(value: &Value) -> Result<Self> {
        let session: Self = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        if !uuid(&session.id) || !uuid(&session.generation) {
            return Err(invalid());
        }
        Ok(session)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenBinding {
    pub agent_id: String,
    pub screen_id: String,
    pub assignment_revision: String,
    pub session: DesktopSession,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_revision: Option<String>,
}
impl ScreenBinding {
    pub fn validate(&self) -> Result<()> {
        if !opaque(&self.agent_id)
            || !uuid(&self.screen_id)
            || !uuid(&self.assignment_revision)
            || self.screen_revision.as_deref().is_some_and(|v| !uuid(v))
        {
            return Err(invalid());
        }
        DesktopSession::parse(&serde_json::to_value(&self.session).unwrap())?;
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedRemote {
    pub url: String,
    pub token: String,
    pub instance_id: String,
    pub control_origin: Option<String>,
    pub name: String,
    pub platform: String,
    pub capabilities: Vec<String>,
}
impl SavedRemote {
    pub fn validate(&self) -> Result<()> {
        worker_url(&self.url)?;
        validate_token(&self.token)?;
        if !(20..=200).contains(&self.instance_id.len())
            || self.name.is_empty()
            || self.name.len() > 800
            || self.platform.len() > 160
            || self.capabilities.len() > 100
            || self.capabilities.iter().any(|s| s.len() > 100)
        {
            return Err(invalid());
        }
        control_origin(self.control_origin.as_deref())?;
        Ok(())
    }
}
#[derive(Clone)]
pub struct Health {
    pub saved: SavedRemote,
    pub state: Value,
    pub session: Option<DesktopSession>,
    pub workspace_scope: Option<String>,
}
pub fn health(
    raw: Value,
    url: &str,
    token: &str,
    workspace: &str,
    required_origin: Option<&str>,
    expected: Option<&SavedRemote>,
    screen: Option<&ScreenBinding>,
    expected_session: Option<&DesktopSession>,
) -> Result<Health> {
    if raw["protocol"] != PROTOCOL || !raw["capabilities"].is_array() {
        return Err(invalid());
    }
    let saved = SavedRemote {
        url: worker_url(url)?,
        token: token.to_owned(),
        instance_id: raw["instanceId"].as_str().ok_or_else(invalid)?.into(),
        name: raw["name"].as_str().ok_or_else(invalid)?.into(),
        platform: raw["platform"].as_str().unwrap_or("unknown").into(),
        control_origin: control_origin(raw["controlOrigin"].as_str())?,
        capabilities: serde_json::from_value(raw["capabilities"].clone()).map_err(|_| invalid())?,
    };
    saved.validate()?;
    if required_origin.is_some_and(|v| saved.control_origin.as_deref() != Some(v))
        || expected.is_some_and(|v| {
            v.instance_id != saved.instance_id || v.control_origin != saved.control_origin
        })
    {
        return Err(invalid());
    }
    let scope = raw
        .get("workspaceScopeId")
        .map(|v| v.as_str().filter(|s| uuid(s)).ok_or_else(invalid))
        .transpose()?;
    if scope.is_some_and(|v| v != workspace) {
        return Err(invalid());
    }
    let session = if raw["desktop"]["kind"] == "virtual" {
        Some(DesktopSession::parse(&raw["desktop"]["session"])?)
    } else {
        None
    };
    if expected_session.is_some_and(|v| Some(v) != session.as_ref()) {
        return Err(invalid());
    }
    if saved.capabilities.iter().any(|c| c == "virtual-desktop-v1")
        && (session.is_none()
            || raw["desktop"]["available"] != true
            || raw["desktop"]["authorized"] != true)
    {
        return Err(invalid());
    }
    if let Some(binding) = screen {
        binding.validate()?;
        if raw["screenId"] != binding.screen_id
            || scope != Some(workspace)
            || session.as_ref() != Some(&binding.session)
            || binding
                .screen_revision
                .as_ref()
                .is_some_and(|r| raw["screenRevision"] != *r)
        {
            return Err(invalid());
        }
    }
    let mut state = json!({"connected":true,"name":saved.name,"platform":saved.platform,
        "mode":"remote","surface":if raw["surface"]=="desktop" {"desktop"}else{"browser"},
        "status":raw["status"].as_str().unwrap_or("已连接"),"capabilities":saved.capabilities});
    if raw["desktop"].is_object() {
        let d = &raw["desktop"];
        state["desktop"] = json!({"kind":d["kind"],"session":session,"available":d["available"]==true,
            "authorized":d["authorized"]==true,"enabled":d["enabled"]==true,
            "width":d["width"].as_u64().unwrap_or(0),"height":d["height"].as_u64().unwrap_or(0),
            "permissions":{"screenRecording":permission(&d["permissions"]["screenRecording"]),
                "accessibility":permission(&d["permissions"]["accessibility"])}});
        if let Some(reason) = d["reason"].as_str().filter(|s| s.len() <= 1000) {
            state["desktop"]["reason"] = json!(reason);
        }
    }
    Ok(Health {
        saved,
        state,
        session,
        workspace_scope: scope.map(str::to_owned),
    })
}
fn permission(value: &Value) -> &str {
    match value.as_str() {
        Some("granted") => "granted",
        Some("denied") => "denied",
        _ => "unknown",
    }
}
pub fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
pub fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn validate_token(value: &str) -> Result<()> {
    if !(24..=16000).contains(&value.len()) || value.chars().any(char::is_control) {
        return Err(ApiError::bad("电脑连接令牌无效。"));
    }
    Ok(())
}
pub fn worker_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| ApiError::bad("电脑地址无效。"))?;
    if value.len() > 2048
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.scheme() != "https"
            && !(url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
    {
        return Err(ApiError::bad("远程电脑必须使用 HTTPS；本机允许 HTTP。"));
    }
    Ok(url.to_string().trim_end_matches('/').into())
}
pub fn control_origin(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let url = url::Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "https" || url.origin().ascii_serialization() != value {
        return Err(invalid());
    }
    Ok(Some(value.into()))
}
pub fn invalid() -> ApiError {
    ApiError::new(409, "电脑身份或隔离配置已变化，请明确重新连接。")
        .with_code("WORKER_CONNECTION_INVALID")
}
pub fn blocked() -> ApiError {
    ApiError::new(409, "无法确认电脑操作已停止，请维护后再使用。")
        .with_code("COMPUTER_CLEANUP_UNKNOWN")
}
pub fn private_takeover() -> ApiError {
    ApiError::new(409, "只有当前接管窗口可以查看接管画面。").with_code("COMPUTER_PRIVATE_TAKEOVER")
}
pub fn takeover_upgrade() -> ApiError {
    ApiError::new(409, "请升级电脑工作进程，再使用私密接管。")
        .with_code("COMPUTER_PRIVATE_TAKEOVER_UNSUPPORTED")
}
pub fn disconnected() -> Value {
    json!({"connected":false,"name":"未连接电脑","platform":"unknown","mode":"remote","surface":"browser","status":"未连接电脑","capabilities":[]})
}
