use super::model;
use crate::error::{ApiError, Result};
use serde_json::{Value, json};

pub const ACTIONS: &[&str] = &[
    "list_files",
    "read_file",
    "write_file",
    "upload_file",
    "download_file",
    "terminal_command",
    "remote_shell",
    "browser_navigate",
    "browser_click",
    "browser_download",
    "browser_type",
    "browser_scroll",
    "browser_back",
    "browser_screenshot",
    "desktop_screenshot",
    "desktop_click",
    "desktop_type",
    "desktop_key",
    "desktop_scroll",
    "desktop_drag",
];
pub fn readonly(kind: &str) -> bool {
    matches!(
        kind,
        "list_files"
            | "read_file"
            | "download_file"
            | "terminal_command"
            | "browser_screenshot"
            | "desktop_screenshot"
    )
}
pub fn frame_action(kind: &str) -> bool {
    matches!(
        kind,
        "browser_navigate"
            | "browser_click"
            | "browser_scroll"
            | "browser_back"
            | "desktop_click"
            | "desktop_key"
            | "desktop_scroll"
            | "desktop_drag"
    )
}
pub fn path(value: &Value, default: Option<&str>) -> Result<String> {
    let value = value
        .as_str()
        .or(default)
        .ok_or_else(|| ApiError::bad("需要工作区内的相对路径。"))?;
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
        || value.split(['/', '\\']).any(|p| p == "..")
    {
        return Err(ApiError::bad("只能访问电脑工作区内的相对路径。"));
    }
    Ok(value.replace('\\', "/"))
}
pub fn action(input: &Value, virtual_desktop: bool) -> Result<Value> {
    let kind = input["type"]
        .as_str()
        .filter(|s| ACTIONS.contains(s))
        .ok_or_else(|| ApiError::bad("不支持的电脑操作。"))?;
    if !input.is_object() {
        return Err(ApiError::bad("电脑操作参数无效。"));
    }
    let mut out = json!({"type":kind});
    for key in [
        "fileId",
        "path",
        "content",
        "command",
        "url",
        "selector",
        "text",
        "direction",
        "x",
        "y",
        "toX",
        "toY",
        "deltaX",
        "deltaY",
        "key",
        "button",
        "clickCount",
        "durationMs",
    ] {
        if let Some(value) = input.get(key) {
            out[key] = value.clone();
        }
    }
    for key in ["path", "content", "command", "url", "selector", "text"] {
        if let Some(value) = out.get(key) {
            if !value.as_str().is_some_and(|s| {
                s.encode_utf16().count() <= if key == "content" { 200_000 } else { 20_000 }
            }) {
                return Err(ApiError::bad("电脑操作内容类型或长度无效。"));
            }
        }
    }
    if matches!(kind, "upload_file" | "download_file") {
        if ["sourceName", "size", "sha256"]
            .iter()
            .any(|k| input.get(k).is_some())
        {
            return Err(ApiError::bad("文件审批信息必须由资料库提供。"));
        }
        if kind == "upload_file" && !out["fileId"].as_str().is_some_and(model::opaque) {
            return Err(ApiError::bad("请选择资料库文件。"));
        }
    }
    if out.get("path").is_some()
        || matches!(
            kind,
            "read_file" | "write_file" | "download_file" | "browser_download" | "remote_shell"
        )
    {
        out["path"] = json!(path(
            &out["path"],
            if kind == "remote_shell" {
                Some(".")
            } else {
                None
            }
        )?);
    }
    if kind == "write_file" && !out["content"].is_string() {
        return Err(ApiError::bad("需要文件内容。"));
    }
    if kind == "terminal_command"
        && !matches!(
            out["command"].as_str(),
            Some("pwd" | "ls" | "date" | "uname")
        )
    {
        return Err(ApiError::bad("终端仅支持只读命令：pwd、ls、date、uname。"));
    }
    if kind == "remote_shell"
        && !out["command"].as_str().is_some_and(|s| {
            !s.trim().is_empty() && s.encode_utf16().count() <= 16000 && !s.contains('\0')
        })
    {
        return Err(ApiError::bad("远程命令无效。"));
    }
    if kind == "browser_navigate" {
        out["url"] = json!(browser_url(&out["url"])?);
    }
    if matches!(kind, "browser_click" | "browser_type" | "browser_download")
        && !out["selector"].as_str().is_some_and(|s| !s.is_empty())
    {
        return Err(ApiError::bad("需要目标元素 selector。"));
    }
    if kind == "browser_type" && !out["text"].is_string() {
        return Err(ApiError::bad("需要输入内容。"));
    }
    if kind == "browser_scroll" && !matches!(out["direction"].as_str(), Some("up" | "down")) {
        return Err(ApiError::bad("滚动方向无效。"));
    }
    if kind.starts_with("desktop_") && kind != "desktop_screenshot" {
        let mut input = out.clone();
        input["type"] = json!(kind.trim_start_matches("desktop_"));
        validate_input(&input, 32768, 32768, true, virtual_desktop)?;
    }
    Ok(out)
}
pub fn browser_url(value: &Value) -> Result<String> {
    let url = url::Url::parse(value.as_str().unwrap_or(""))
        .map_err(|_| ApiError::bad("请输入完整的网址。"))?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ApiError::bad("浏览器仅支持不带凭据的 HTTP(S) 网址。"));
    }
    Ok(url.to_string())
}
pub fn validate_input(
    input: &Value,
    width: u64,
    height: u64,
    desktop: bool,
    virtual_desktop: bool,
) -> Result<()> {
    let kind = input["type"].as_str().unwrap_or("");
    let point = |x: &str, y: &str| -> Result<()> {
        if !input[x]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0 && n < width as f64)
            || !input[y]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0 && n < height as f64)
        {
            return Err(ApiError::bad("输入坐标不在当前画面内。"));
        }
        Ok(())
    };
    match kind {
        "click" | "drag" => {
            point("x", "y")?;
            if kind == "drag" {
                point("toX", "toY")?;
            }
            if input.get("button").is_some()
                && !matches!(input["button"].as_str(), Some("left" | "right"))
            {
                return Err(ApiError::bad("鼠标按键无效。"));
            }
            if input.get("clickCount").is_some()
                && !matches!(input["clickCount"].as_u64(), Some(1 | 2))
            {
                return Err(ApiError::bad("点击次数无效。"));
            }
            if input.get("durationMs").is_some()
                && !input["durationMs"]
                    .as_u64()
                    .is_some_and(|n| (100..=2000).contains(&n))
            {
                return Err(ApiError::bad("拖动时间无效。"));
            }
        }
        "type" => {
            if !input["text"].as_str().is_some_and(|s| {
                !s.is_empty()
                    && !s.contains('\0')
                    && s.encode_utf16().count() <= if virtual_desktop { 300 } else { 20000 }
            }) {
                return Err(ApiError::bad("粘贴文本过长或无效，较长内容请上传文件。"));
            }
        }
        "key" => validate_key(input["key"].as_str().unwrap_or(""), desktop)?,
        "scroll" => {
            if !input["deltaY"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.abs() <= 4000.0)
                || input.get("deltaX").is_some_and(|v| {
                    !v.as_f64()
                        .is_some_and(|n| n.is_finite() && n.abs() <= 4000.0)
                })
            {
                return Err(ApiError::bad("滚动距离无效。"));
            }
        }
        "navigate" if !desktop => {
            browser_url(&input["url"])?;
        }
        _ => return Err(ApiError::bad("不支持此画面输入。")),
    }
    Ok(())
}
fn validate_key(key: &str, desktop: bool) -> Result<()> {
    if !desktop
        && ![
            "Enter",
            "Tab",
            "Escape",
            "Backspace",
            "Delete",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "ControlOrMeta+A",
        ]
        .contains(&key)
    {
        return Err(ApiError::bad("快捷键不受支持。"));
    }
    let normalized = key.to_ascii_lowercase();
    let mut parts = normalized.split('+').collect::<Vec<_>>();
    let final_key = parts.pop().unwrap_or("");
    let function_key = final_key
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n));
    if key.len() > 100
        || parts.len() > 4
        || (![
            "enter",
            "tab",
            "escape",
            "space",
            "backspace",
            "delete",
            "insert",
            "arrowup",
            "arrowdown",
            "arrowleft",
            "arrowright",
            "home",
            "end",
            "pageup",
            "pagedown",
        ]
        .contains(&final_key)
            && !function_key
            && !(final_key.len() == 1
                && final_key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"=-][;'\\,/.`".contains(&b))))
    {
        return Err(ApiError::bad("快捷键不受支持。"));
    }
    let mut modifiers = std::collections::HashSet::new();
    for part in parts {
        let modifier = match part {
            "control" | "ctrl" | "controlormeta" => "control",
            "meta" | "command" | "cmd" => "meta",
            "shift" => "shift",
            "alt" | "option" => "alt",
            _ => return Err(ApiError::bad("快捷键不受支持。")),
        };
        if !modifiers.insert(modifier) {
            return Err(ApiError::bad("快捷键修饰键重复。"));
        }
    }
    Ok(())
}

pub fn shell_result(value: &Value) -> Result<()> {
    let stdout = value["stdout"].as_str().ok_or_else(model::invalid)?;
    let stderr = value["stderr"].as_str().ok_or_else(model::invalid)?;
    let exit = value.get("exitCode").ok_or_else(model::invalid)?;
    let signal = value.get("signal");
    if stdout.len() + stderr.len() > 256 * 1024
        || !(exit.is_null() || exit.as_u64().is_some_and(|n| n <= 255))
        || signal.is_some_and(|s| {
            !s.as_str().is_some_and(|s| {
                s.strip_prefix("SIG").is_some_and(|s| {
                    !s.is_empty()
                        && s.len() <= 16
                        && s.bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                })
            })
        })
        || ["truncated", "timedOut", "cancelled"]
            .iter()
            .any(|k| !value[*k].is_boolean())
        || !value["durationMs"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0)
        || value
            .get("resourceLimit")
            .is_some_and(|v| !matches!(v.as_str(), Some("memory" | "disk-reserve" | "pids")))
    {
        return Err(model::invalid());
    }
    Ok(())
}
