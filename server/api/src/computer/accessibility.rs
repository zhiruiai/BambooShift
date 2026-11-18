use super::{
    controller::Controller,
    controls, model,
    transport::{Authority, Request, Target},
};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub(super) const PRESS: &str = "desktop_ax_press";
pub(crate) const SET_TEXT: &str = "desktop_ax_set_text";
pub(crate) const OPEN: &str = "desktop_ax_open";

pub(super) fn mutation(kind: &str) -> bool {
    matches!(kind, PRESS | SET_TEXT | OPEN)
}

pub(super) fn require_ready(target: &Target, state: &Value) -> Result<()> {
    if !target.saved.has(model::MACOS_ACCESSIBILITY) || state["surface"] != "accessibility" {
        return Err(ApiError::new(409, "请先在电脑面板选择此 Mac 的本机应用。"));
    }
    if state["desktop"]["accessibilityReady"] != true {
        return Err(ApiError::new(
            403,
            "请为这台 Mac 的桌面助手开启辅助功能权限。",
        ));
    }
    Ok(())
}

pub(super) fn worker_error(code: &str) -> Option<ApiError> {
    let (code, message) = match code {
        "AX_APP_UNAVAILABLE" => (
            "AX_APP_UNAVAILABLE",
            "找不到唯一的目标应用，请确认应用已安装或已打开。",
        ),
        "AX_APP_PROTECTED" => (
            "AX_APP_PROTECTED",
            "无法通过应用控制打开 BambooShift 或其助手。",
        ),
        "AX_WINDOW_UNAVAILABLE" => (
            "AX_WINDOW_UNAVAILABLE",
            "此应用还没有可读取的窗口，请确认窗口已打开。",
        ),
        "AX_STALE_APP" => (
            "AX_STALE_APP",
            "已安装的应用发生变化，请重新查看并申请打开。",
        ),
        "AX_STALE_SNAPSHOT" => (
            "AX_STALE_SNAPSHOT",
            "应用窗口或控件已变化或过期，请重新读取后申请操作。",
        ),
        "AX_ACTION_UNAVAILABLE" => (
            "AX_ACTION_UNAVAILABLE",
            "当前无法操作该控件，请重新读取应用。",
        ),
        "AX_OPEN_UNCONFIRMED" => (
            "AX_OPEN_UNCONFIRMED",
            "未能确认应用已打开，请在本机检查后再试。",
        ),
        "AX_PRESS_UNCONFIRMED" => (
            "AX_PRESS_UNCONFIRMED",
            "应用未确认点按结果，请核对当前界面后再试。",
        ),
        "AX_TEXT_UNCONFIRMED" => (
            "AX_TEXT_UNCONFIRMED",
            "应用未确认文字已填写，请重新查看应用。",
        ),
        _ => return None,
    };
    Some(ApiError::new(409, message).with_code(code))
}

fn short_text(value: &Value, limit: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() <= limit && !s.chars().any(char::is_control))
}

pub(super) fn action_payload(kind: &str, input: &Value) -> Result<Value> {
    if kind == OPEN {
        crate::error::only_fields(input, &["type", "bundleId", "expectedTargetRevision"])?;
        let bundle_id = input["bundleId"]
            .as_str()
            .filter(|id| valid_bundle_id(id))
            .ok_or_else(|| ApiError::bad("请选择已安装 Mac 应用的有效标识符。"))?;
        return Ok(json!({"type":OPEN,"bundleId":bundle_id}));
    }
    let mut fields = vec![
        "type",
        "snapshotToken",
        "elementId",
        "expectedTargetRevision",
    ];
    if kind == SET_TEXT {
        fields.push("text");
    }
    crate::error::only_fields(input, &fields)
        .map_err(|_| ApiError::bad("本机应用操作仅接受控件引用和填写文字所需的参数。"))?;
    let token = input["snapshotToken"].as_str().unwrap_or_default();
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !input["elementId"].as_str().is_some_and(model::opaque)
    {
        return Err(ApiError::bad("请选择最近一次本机应用检查返回的控件。"));
    }
    let mut payload = json!({"type":kind,"snapshotToken":token,"elementId":input["elementId"]});
    if kind == SET_TEXT {
        let text = input["text"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.chars().take(2001).count() <= 2000
                    && s.chars()
                        .all(|c| !c.is_control() || matches!(c, '\n' | '\t'))
            })
            .ok_or_else(|| ApiError::bad("请输入不超过 2000 个字符的本机应用文字。"))?;
        payload["text"] = json!(text);
    }
    Ok(payload)
}

fn valid_bundle_id(id: &str) -> bool {
    id.len() <= 300
        && id.contains('.')
        && id.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && !id.to_ascii_lowercase().starts_with("com.openbot.")
}

pub(super) struct ApprovalTarget {
    pub details: Value,
    // Pending actions are invalidated at restart. Keep this binding out of action storage and chat.
    pub app_identity: Option<String>,
}

pub(super) fn launch_payload(action: &Value, identity: Option<&str>) -> Result<Value> {
    Ok(json!({"type":OPEN,"bundleId":action["target"]["bundleId"],
        "identity":identity.ok_or_else(model::invalid)?}))
}

async fn launch_target(
    target: &Arc<Target>,
    bundle_id: &str,
    authorize: Authority,
) -> Result<ApprovalTarget> {
    if !target.saved.has(model::MACOS_APP_LAUNCH) {
        return Err(ApiError::new(
            409,
            "此 Mac 助手尚不支持打开应用，请先升级。",
        ));
    }
    let input = json!({"type":"desktop_ax_open_target","bundleId":bundle_id});
    let mut request = Request::post("/execute", &input);
    request.max_bytes = 4096;
    request.timeout = Duration::from_secs(10);
    let value = target.request(request, authorize).await?.json()?;
    let confirmed_bundle_id = value["bundleId"]
        .as_str()
        .filter(|id| valid_bundle_id(id) && id.eq_ignore_ascii_case(bundle_id))
        .ok_or_else(model::invalid)?;
    let app_name = value["app"]
        .as_str()
        .filter(|name| !name.trim().is_empty() && short_text(&value["app"], 512))
        .ok_or_else(model::invalid)?;
    let identity = value["identity"]
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(model::invalid)?;
    Ok(ApprovalTarget {
        details: json!({"app":app_name,"bundleId":confirmed_bundle_id}),
        app_identity: Some(identity.to_owned()),
    })
}

pub(crate) async fn inspect(
    controller: &Arc<Controller>,
    agent: &str,
    app: &str,
    authorize: Authority,
) -> Result<Value> {
    let target = controls::target(controller, Some(agent), authorize.clone()).await?;
    target
        .request(Request::get("/health"), authorize.clone())
        .await?;
    require_ready(&target, &target.state().await)?;
    let body = json!({"type": "desktop_ax_inspect", "app": app});
    let mut request = Request::post("/execute", &body);
    request.max_bytes = 128 * 1024;
    request.timeout = Duration::from_secs(20);
    let value = target.request(request, authorize.clone()).await?.json()?;
    require_ready(&target, &target.state().await)?;
    authorize().await?;
    Ok(value)
}

pub(super) async fn approval_target(
    target: &Arc<Target>,
    payload: &Value,
    authorize: Authority,
) -> Result<ApprovalTarget> {
    if payload["type"] == OPEN {
        let bundle_id = payload["bundleId"].as_str().ok_or_else(model::invalid)?;
        return launch_target(target, bundle_id, authorize).await;
    }
    let setting_text = payload["type"] == SET_TEXT;
    let mut input = json!({
        "type":"desktop_ax_target",
        "snapshotToken":payload["snapshotToken"],
        "elementId":payload["elementId"],
    });
    if setting_text {
        input["action"] = json!("setText");
    }
    let mut request = Request::post("/execute", &input);
    request.max_bytes = 4096;
    request.timeout = Duration::from_secs(10);
    let value = target.request(request, authorize).await?.json()?;
    if !short_text(&value["app"], 512)
        || !short_text(&value["role"], 160)
        || !short_text(&value["label"], 1024)
    {
        return Err(model::invalid());
    }
    let mut approved = json!({"app":value["app"],"role":value["role"],"label":value["label"]});
    if let Some(window_title) = value.get("windowTitle") {
        if !short_text(window_title, 1024) {
            return Err(model::invalid());
        }
        approved["windowTitle"] = window_title.clone();
    }
    Ok(ApprovalTarget {
        details: approved,
        app_identity: None,
    })
}

#[cfg(test)]
#[path = "../../tests/unit/computer/accessibility.rs"]
mod tests;
