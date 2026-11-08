use super::{
    controller::Controller,
    controls::{self, Lease},
    model,
    transport::{Authority, Reply, Request, Target},
};
use crate::{db::now, error::Result, workspace::WorkspaceAccess};
use axum::{
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use std::sync::Arc;

const PROOF_HEADER: &str = "x-openbot-computer-lease";

pub(super) fn supported(state: &Value) -> bool {
    state["capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|cap| cap == model::PRIVATE_TAKEOVER))
}

pub(super) fn worker_access(request: &Request, capabilities: &[String]) -> Result<()> {
    if request.takeover_lease.as_deref().is_some_and(|proof| {
        request.path != "/screenshot"
            || request.method != reqwest::Method::GET
            || !model::uuid(proof)
    }) {
        return Err(model::private_takeover());
    }
    let needs_protection = request.takeover_lease.is_some()
        || request.path == "/takeover/start"
        || (request.path == "/screenshot" && !request.legacy_frame_checked);
    if needs_protection
        && !capabilities
            .iter()
            .any(|cap| cap == model::PRIVATE_TAKEOVER)
    {
        return Err(model::takeover_upgrade());
    }
    Ok(())
}

fn request() -> Request {
    let mut request = Request::get("/screenshot");
    request.max_bytes = model::MAX_FILE;
    request
}

async fn public_status(
    controller: &Controller,
    target: &Arc<Target>,
    authorize: &Authority,
    legacy: bool,
) -> Result<()> {
    if controller
        .takeovers
        .lock()
        .await
        .values()
        .any(|lease| lease.expires_at > now() && Arc::ptr_eq(&lease.target, target))
    {
        return Err(model::private_takeover());
    }
    if legacy && controls::read_status(target, authorize.clone()).await?["active"] != false {
        return Err(model::private_takeover());
    }
    Ok(())
}

pub async fn screenshot(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    authorize: Authority,
) -> Result<Reply> {
    let target = controls::target(controller, agent, authorize.clone()).await?;
    let legacy = !supported(&target.state().await);
    public_status(controller, &target, &authorize, legacy).await?;
    let mut request = request();
    // A current worker checks both ends of the actual capture inside its input queue.
    // Older workers cannot start a takeover through OpenBot. Also fence orphan sessions.
    request.legacy_frame_checked = legacy;
    let reply = target.request(request, authorize.clone()).await?;
    controls::png_dimensions(&reply.bytes)?;
    public_status(controller, &target, &authorize, legacy).await?;
    target.active()?;
    authorize().await?;
    Ok(reply)
}

async fn holder(
    controller: &Controller,
    slot: &str,
    agent: Option<&str>,
    actor: &WorkspaceAccess,
    proof: &str,
) -> Result<Lease> {
    controller
        .takeovers
        .lock()
        .await
        .get(slot)
        .filter(|lease| {
            lease.id == proof
                && lease.agent_id.as_deref() == agent
                && lease.user_id == actor.user_id
                && lease.session_id == actor.session_id
                && lease.expires_at > now()
        })
        .cloned()
        .ok_or_else(model::private_takeover)
}

pub(super) async fn private(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    actor: &WorkspaceAccess,
    headers: &HeaderMap,
    authorize: Authority,
) -> Result<Response> {
    let mut proofs = headers.get_all(PROOF_HEADER).iter();
    let proof = proofs
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|proof| model::uuid(proof) && proofs.next().is_none())
        .ok_or_else(model::private_takeover)?;
    let slot = controls::key(controller, agent).await;
    let lease = holder(controller, &slot, agent, actor, proof).await?;
    let target = controls::target(controller, agent, authorize.clone()).await?;
    if !Arc::ptr_eq(&lease.target, &target) {
        return Err(model::private_takeover());
    }
    let mut request = request();
    request.takeover_lease = Some(lease.id.clone());
    let reply = target.request(request, authorize.clone()).await?;
    let (width, height) = controls::png_dimensions(&reply.bytes)?;
    let surface = reply
        .headers
        .get("x-computer-surface")
        .and_then(|v| v.to_str().ok());
    if lease.value["width"] != width
        || lease.value["height"] != height
        || lease.value["surface"].as_str() != surface
    {
        return Err(model::private_takeover());
    }
    authorize().await?;
    let current = holder(controller, &slot, agent, actor, proof).await?;
    if !Arc::ptr_eq(&current.target, &target) {
        return Err(model::private_takeover());
    }
    target.active()?;
    response(reply, "takeover")
}

pub(super) fn response(reply: Reply, visibility: &'static str) -> Result<Response> {
    let (width, height) = controls::png_dimensions(&reply.bytes)?;
    let mut response = reply.bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "image/png".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    headers.insert("x-openbot-frame-visibility", visibility.parse().unwrap());
    headers.insert("x-frame-width", width.to_string().parse().unwrap());
    headers.insert("x-frame-height", height.to_string().parse().unwrap());
    for name in ["x-captured-at", "x-computer-surface"] {
        if let Some(value) = reply.headers.get(name) {
            headers.insert(name, value.clone());
        }
    }
    Ok(response)
}
