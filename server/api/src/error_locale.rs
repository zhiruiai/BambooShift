use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, header},
    response::Response,
};
use serde_json::Value;

pub fn english(headers: &HeaderMap) -> bool {
    let mut selected = (0f32, false);
    for item in headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
    {
        let mut parts = item.trim().split(';');
        let tag = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let supported = if tag == "en" || tag.starts_with("en-") {
            Some(true)
        } else if tag == "zh" || tag.starts_with("zh-") {
            Some(false)
        } else {
            None
        };
        let quality = parts
            .find_map(|p| {
                p.trim()
                    .strip_prefix("q=")
                    .map(|q| q.parse::<f32>().unwrap_or(0.))
            })
            .unwrap_or(1.);
        if let Some(value) = supported {
            if quality > selected.0 && quality <= 1. {
                selected = (quality, value);
            }
        }
    }
    selected.1
}
pub async fn translate(response: Response) -> Response {
    if !response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("application/json"))
    {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let bytes = match to_bytes(body, 65536).await {
        Ok(v) => v,
        Err(_) => {
            return Response::from_parts(
                parts,
                Body::from("{\"error\":\"Request failed.\",\"code\":\"INTERNAL_ERROR\"}"),
            );
        }
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    if let Some(message) = value["error"].as_str() {
        value["error"] = Value::String(
            message_en(message, value["code"].as_str().unwrap_or("INTERNAL_ERROR")).into(),
        );
    }
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(
        parts,
        Body::from(serde_json::to_vec(&value).unwrap_or_default()),
    )
}
fn message_en(message: &str, code: &str) -> &'static str {
    match message {
        "本机免登录模式未启用。" => "Personal desktop mode is not enabled.",
        "请从本机客户端打开这个工作空间。" => {
            "Open this workspace from the desktop app on this computer."
        }
        "本机账户当前不可用。" => "The personal desktop account is unavailable.",
        "本机免登录模式需要独立的个人数据目录。" => {
            "Personal desktop mode requires a separate data directory."
        }
        "本机工作空间不可用。" => "The personal desktop workspace is unavailable.",
        "本机个人空间无需密码。" => {
            "The personal desktop workspace does not use a password."
        }
        "本机个人空间无需注册，请从客户端直接打开。" => {
            "Open the personal workspace from the desktop app; registration is not needed."
        }
        "本机个人空间无需登录，请从客户端直接打开。" => {
            "Open the personal workspace from the desktop app; sign-in is not needed."
        }
        "此电脑未启用本机命令执行能力。" => {
            "Local command execution is not enabled on this computer."
        }
        "Webhook 密钥无效或已失效。" => {
            "The webhook secret is invalid or no longer active."
        }
        "Webhook 设置已变化，请刷新后重试。" => {
            "Webhook settings changed. Refresh and try again."
        }
        "Webhook 版本无效。" => "The webhook revision is invalid.",
        "Webhook 仅适用于本地 Bot 的单人会话。" => {
            "Webhooks require a direct chat with a local Bot."
        }
        "Webhook 正文必须是 JSON 对象。" => "The webhook body must be a JSON object.",
        "Webhook 投递标识无效。" => "The webhook idempotency key is invalid.",
        "Webhook 暂时不可用，请稍后重试。" => {
            "The webhook is temporarily unavailable. Try again later."
        }
        "此 Webhook 投递标识已用于其他内容。" => {
            "This webhook idempotency key was already used with a different body."
        }
        "此例行任务的 Webhook 投递过于频繁。" => {
            "This routine is receiving webhook deliveries too quickly."
        }
        "此例行任务已暂停。" => "This routine is paused.",
        "Webhook 任务需要已配置的模型。" => "Webhook runs require a configured model.",
        "团队未开放成员发布技能。" => {
            "This team has not enabled member skill publishing."
        }
        "团队技能发布权限已变化，请刷新后重试。" => {
            "The team's skill publishing permission changed. Refresh and try again."
        }
        "团队技能发布权限设置无效。" => {
            "The team skill publishing setting is invalid."
        }
        "只有原发布者可以同步此团队技能。" => {
            "Only the original publisher can sync this team skill."
        }
        "团队所有者已撤除此发布。" => "The team owner removed this publication.",
        "此团队技能链接不可用。" => "This team skill link is unavailable.",
        "只有发布者或团队所有者可以撤回此技能。" => {
            "Only the publisher or team owner can withdraw this skill."
        }
        "不能发布随 Bot 模板安装或复制的技能。" => {
            "Skills installed with a Bot template or copied from a Bot cannot be published."
        }
        "应用工具权限已变化，请刷新后重新核对。" => {
            "App tool access changed. Refresh and review the current setting."
        }
        "此应用工具已由工作空间所有者停用。" => {
            "The workspace owner disabled this app tool."
        }
        "此连接已达到工具权限记录上限。" => {
            "This connection has reached its tool access settings limit."
        }
        "应用工具权限设置无效。" => "The app tool access settings are invalid.",
        "请填写 1 到 4 条不同的公开查询，每条最多 160 个字符。" => {
            "Enter one to four distinct public queries, up to 160 characters each."
        }
        "例行任务的搜索授权已变化，请刷新后重新确认。" => {
            "The routine's search permission changed. Refresh and review it again."
        }
        "公开网页搜索授权只适用于本地 Bot 的单聊例行任务。" => {
            "Public search permissions apply only to routines in a direct chat with a local Bot."
        }
        "新例行任务无需旧配置。" => {
            "A new routine does not have a previous configuration."
        }
        "只能在自己拥有的个人空间管理私有技能。" => {
            "Private skills can be managed only in your own personal workspace."
        }
        "私有技能或目标 Bot 已变化，请刷新并重新核对。" => {
            "The private skill or target Bot changed. Refresh and review it again."
        }
        "目标 Bot 已启用同名技能，请先在该 Bot 的技能设置中处理。" => {
            "This Bot already has an enabled skill with that name. Review it in the Bot's skill settings first."
        }
        "私有技能设置无效。" => "The private skill settings are invalid.",
        "应用授权范围已变化，请查看当前操作后重新确认。" => {
            "The app permission scope changed. Review the current action before confirming again."
        }
        "已保存 20 项应用权限，请撤销一项或仅允许本次操作。" => {
            "You have 20 saved app permissions. Revoke one or allow this action once."
        }
        "仅个人空间支持管理已保存的应用权限。" => {
            "Saved app permissions can only be managed in a personal workspace."
        }
        "应用授权不存在。" => "The saved app permission could not be found.",
        "请先登录你的账户。" => "Please sign in to your account.",
        "请登录平台运营后台。" => "Please sign in to the platform administration portal.",
        "邮箱、密码或账户权限不正确。" => {
            "The email, password, or account access is incorrect."
        }
        "该邮箱已注册，请直接登录。" => {
            "This email is already registered. Please sign in."
        }
        "请选择个人使用或创建团队。" => "Choose personal use or create a team.",
        "请填写有效的邮箱地址。" => "Enter a valid email address.",
        "密码需要 10 到 128 个字符。" => "Passwords must contain 10 to 128 characters.",
        "账户已变化，请刷新后重试。" | "账号已切换，请刷新后重试。" => {
            "Your account has changed. Refresh and try again."
        }
        "账户设置包含不支持的字段。" => {
            "The account settings contain unsupported fields."
        }
        "当前密码不正确。" => "The current password is incorrect.",
        "新密码不能与当前密码相同。" => {
            "The new password must differ from your current password."
        }
        "账户状态已变化，请重新登录。" => {
            "The account state has changed. Please sign in again."
        }
        "只有空间拥有者可以管理这项设置。" => {
            "Only the workspace owner can manage this setting."
        }
        "你没有访问此工作空间的权限。" => "You do not have access to this workspace.",
        "个人空间不支持团队成员管理。" => {
            "Personal workspaces do not support team membership management."
        }
        "只有空间拥有者可以移除其他成员。" => {
            "Only the workspace owner can remove other members."
        }
        "不能移除空间拥有者。" => "The workspace owner cannot be removed.",
        "成员不存在。" => "The member does not exist.",
        "邀请不存在。" => "The invitation does not exist.",
        "邀请已使用、过期或撤销。" => {
            "The invitation has been used, has expired, or was revoked."
        }
        "你已经是这个团队的成员。" => "You are already a member of this team.",
        "待使用邀请过多，请先撤销旧邀请。" => {
            "There are too many pending invitations. Revoke an old invitation first."
        }
        "初始化码无效或平台已经初始化。" => {
            "The setup code is invalid or the platform is already initialized."
        }
        "不能通过用户管理停用运营管理员。" => {
            "Platform administrators cannot be suspended through user management."
        }
        "尝试过于频繁，请稍后重试。" => "Too many attempts. Please try again later.",
        "登录服务繁忙，请稍后重试。" => {
            "The sign-in service is busy. Please try again later."
        }
        "此请求来源不受信任。" => "This request origin is not trusted.",
        "请求内容不是有效的 JSON。" => "The request does not contain valid JSON.",
        "创建预览请求无效。" => "The creation preview request is invalid.",
        "创建要求需要 1 到 3000 个字符。" => {
            "The creation brief must contain 1 to 3,000 characters."
        }
        "模型没有返回有效的创建预览，请调整要求后重试。" => {
            "The model returned an invalid draft. Refine your brief and try again."
        }
        "网站项目清单无效。" => "The website project manifest is invalid.",
        "网站项目或文件不存在。" => "The website project or file could not be found.",
        "分享页面不可用。" => "The shared page is unavailable.",
        "网站项目分享设置无效。" => "The website sharing settings are invalid.",
        "页面访问权限已变化，请刷新后重试。" => {
            "Page access has changed. Refresh and try again."
        }
        "只有空间拥有者或项目创建者可以管理分享。" => {
            "Only the workspace owner or project creator can manage sharing."
        }
        "页面读取过于频繁，请稍后重试。" => {
            "Too many page requests. Please try again later."
        }
        "网站项目的源文件已变化，请重新读取后再交付。" => {
            "Website source files changed. Read them again before delivering the project."
        }
        "网站项目最多 10 MiB，每个文件最多 4 MiB。" => {
            "Website projects can contain up to 10 MiB, with a 4 MiB limit per file."
        }
        "接口不存在。" => "This endpoint does not exist.",
        "此接口不支持该请求方式。" => {
            "This request method is not supported by this endpoint."
        }
        _ => match code {
            "BAD_REQUEST" | "INVALID_INPUT" => "The request contains invalid fields.",
            "UNAUTHENTICATED" => "Please sign in to continue.",
            "FORBIDDEN" => "You do not have permission to perform this action.",
            "NOT_FOUND" => "The requested item does not exist.",
            "CONFLICT" => "The item has changed. Refresh and try again.",
            "PAYLOAD_TOO_LARGE" => "The request is too large.",
            "RATE_LIMITED" => "Too many requests. Please try again later.",
            "GONE" => "This request is no longer available.",
            _ => "The service is temporarily unavailable. Please try again later.",
        },
    }
}
