use super::{
    controller::Controller,
    model, screen_bindings,
    transport::{Authority, Request, Target},
    validation,
};
use crate::{
    db::now,
    error::{ApiError, Result},
    workspace::WorkspaceAccess,
};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone)]
pub struct Lease {
    pub id: String,
    pub agent_id: Option<String>,
    pub user_id: String,
    pub session_id: String,
    pub expires_at: i64,
    pub value: Value,
    pub target: Arc<Target>,
}
pub(super) async fn key(controller: &Controller, agent: Option<&str>) -> String {
    if controller.is_local().await {
        "default".into()
    } else {
        agent.unwrap_or("default").into()
    }
}
pub async fn target(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    authorize: Authority,
) -> Result<Arc<Target>> {
    if controller.tasks.blocked(if controller.is_local().await {
        None
    } else {
        agent
    }) {
        return Err(model::blocked());
    }
    match agent {
        Some(agent) => screen_bindings::target(controller, agent, authorize, false).await,
        None => controller.target(authorize).await,
    }
}
pub use super::takeover_frames::screenshot;
pub fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 24
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || &bytes[12..16] != b"IHDR"
    {
        return Err(ApiError::new(409, "电脑没有返回有效截图。"));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
        return Err(ApiError::new(413, "电脑截图尺寸无效。"));
    }
    Ok((width, height))
}
pub async fn takeover_status(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    authorize: Authority,
) -> Result<Value> {
    let target = target(controller, agent, authorize.clone()).await?;
    let slot = key(controller, agent).await;
    let observed = controller.takeovers.lock().await.get(&slot).cloned();
    let value = read_status(&target, authorize).await?;
    if let Some(observed) = observed.filter(|_| value["active"] == false) {
        let mut leases = controller.takeovers.lock().await;
        if leases.get(&slot).is_some_and(|current| {
            current.id == observed.id && Arc::ptr_eq(&current.target, &target)
        }) {
            leases.remove(&slot);
        }
    }
    Ok(value)
}
pub(super) async fn read_status(target: &Arc<Target>, authorize: Authority) -> Result<Value> {
    let value = target
        .request(Request::get("/takeover/status"), authorize)
        .await?
        .json()?;
    if !value["active"].is_boolean() || !value["width"].is_u64() || !value["height"].is_u64() {
        return Err(model::invalid());
    }
    let mut safe = json!({"active":value["active"],"width":value["width"],"height":value["height"],"surface":value["surface"]});
    if let Some(expires) = value["expiresAt"].as_str() {
        safe["expiresAt"] = json!(expires);
    }
    Ok(safe)
}
pub async fn start(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    actor: &WorkspaceAccess,
    authorize: Authority,
) -> Result<Value> {
    let _guard = controller.management.lock().await;
    controller.active()?;
    authorize().await?;
    let slot = key(controller, agent).await;
    let target = target(controller, agent, authorize.clone()).await?;
    if !super::takeover_frames::supported(&target.state().await) {
        return Err(model::takeover_upgrade());
    }
    if controller
        .takeovers
        .lock()
        .await
        .get(&slot)
        .is_some_and(|lease| lease.expires_at > now() && Arc::ptr_eq(&lease.target, &target))
    {
        return Err(model::private_takeover());
    }
    let scope = if controller.is_local().await {
        None
    } else {
        agent
    };
    super::approvals::cancel_scope(controller, scope, "用户正在接管电脑，原操作已取消。").await?;
    if read_status(&target, authorize.clone()).await?["active"] != false {
        return Err(model::private_takeover());
    }
    let mut leases = controller.takeovers.lock().await;
    let value = target
        .request(
            Request::post("/takeover/start", &json!({})),
            authorize.clone(),
        )
        .await?
        .json()?;
    let expires = value["expiresAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .filter(|v| *v > now() && *v < now() + 600_000);
    let lease = value["leaseId"].as_str().filter(|s| model::uuid(s));
    if value["active"] != true
        || expires.is_none()
        || lease.is_none()
        || !value["width"].is_u64()
        || !value["height"].is_u64()
        || !matches!(value["surface"].as_str(), Some("browser" | "desktop"))
    {
        target.poison();
        return Err(model::blocked());
    }
    leases.insert(
        slot,
        Lease {
            id: lease.unwrap().into(),
            agent_id: agent.map(str::to_owned),
            user_id: actor.user_id.clone(),
            session_id: actor.session_id.clone(),
            expires_at: expires.unwrap(),
            value: value.clone(),
            target,
        },
    );
    controller.changed();
    Ok(value)
}
pub async fn input(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    actor: &WorkspaceAccess,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    let lease = controller
        .takeovers
        .lock()
        .await
        .get(&key(controller, agent).await)
        .cloned()
        .ok_or_else(|| ApiError::new(409, "请先开始人工接管。"))?;
    if lease.agent_id.as_deref() != agent
        || body["leaseId"] != lease.id
        || actor.user_id != lease.user_id
        || actor.session_id != lease.session_id
        || lease.expires_at <= now()
    {
        return Err(ApiError::new(
            409,
            "接管已过期或属于其他窗口，请重新开始接管。",
        ));
    }
    let state = lease.target.state().await;
    validation::validate_input(
        body,
        lease.value["width"].as_u64().unwrap_or(0),
        lease.value["height"].as_u64().unwrap_or(0),
        lease.value["surface"] == "desktop",
        state["desktop"]["kind"] == "virtual",
    )?;
    let recording = crate::teaching::before_input(controller, actor, &lease, body).await?;
    let value = lease
        .target
        .request(Request::post("/takeover/input", body), authorize)
        .await?
        .json()?;
    if value["ok"] != true {
        return Err(model::invalid());
    }
    crate::teaching::input_succeeded(recording).await?;
    Ok(value)
}
pub async fn end(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    actor: &WorkspaceAccess,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    let _guard = controller.management.lock().await;
    authorize().await?;
    let slot = key(controller, agent).await;
    let lease = controller.takeovers.lock().await.get(&slot).cloned();
    let Some(lease) = lease else {
        return Ok(json!({"active":false}));
    };
    if lease.agent_id.as_deref() != agent
        || body["leaseId"] != lease.id
        || actor.user_id != lease.user_id
        || actor.session_id != lease.session_id
    {
        return Err(ApiError::new(409, "接管已变化，不能结束其他窗口的接管。"));
    }
    if lease.expires_at <= now()
        && read_status(&lease.target, authorize.clone()).await?["active"] == false
    {
        controller.takeovers.lock().await.remove(&slot);
        controller.changed();
        return Ok(json!({"active":false}));
    }
    let result = lease
        .target
        .request(
            Request::post("/takeover/end", &json!({"leaseId":lease.id})),
            authorize,
        )
        .await;
    if result.is_err() {
        lease.target.poison();
        return Err(model::blocked());
    }
    let value = result?.json()?;
    if value["active"] != false {
        lease.target.poison();
        return Err(model::blocked());
    }
    controller.takeovers.lock().await.remove(&slot);
    controller.changed();
    Ok(value)
}
pub async fn surface(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    let surface = body["surface"]
        .as_str()
        .filter(|s| ["browser", "desktop"].contains(s))
        .ok_or_else(|| ApiError::bad("电脑界面类型无效。"))?;
    if surface == "desktop" && body["confirm"] != true {
        return Err(ApiError::bad("请明确确认开启电脑桌面。"));
    }
    let _guard = controller.management.lock().await;
    controller.active()?;
    authorize().await?;
    let scope = if controller.is_local().await {
        None
    } else {
        agent
    };
    super::approvals::cancel_scope(controller, scope, "电脑界面已切换，原操作已失效。").await?;
    let target = target(controller, agent, authorize.clone()).await?;
    if let Some(lease) = controller
        .takeovers
        .lock()
        .await
        .remove(&key(controller, agent).await)
    {
        let reply = lease
            .target
            .request(
                Request::post("/takeover/end", &json!({"leaseId":lease.id})),
                authorize.clone(),
            )
            .await?;
        if reply.json()?["active"] != false {
            target.poison();
            return Err(model::blocked());
        }
    }
    let state = target.state().await;
    if surface == "desktop" && state["desktop"]["kind"] != "virtual" {
        return Err(ApiError::new(403, "平台工作空间不能控制宿主整机桌面。"));
    }
    target
        .request(Request::post("/surface", body), authorize.clone())
        .await?;
    target.request(Request::get("/health"), authorize).await?;
    controller.changed();
    Ok(target.state().await)
}
