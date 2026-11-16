use super::{
    authorization,
    controller::Controller,
    model, private_config,
    transport::{Authority, Request, Target},
};
use crate::error::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preference {
    version: u8,
    workspace_id: String,
    user_id: String,
    surface: String,
}

fn load(controller: &Controller) -> Result<Option<Preference>> {
    let Some(bytes) = private_config::read_private(
        &controller
            .store
            .directory
            .join("computer/local-surface.json"),
        4096,
    )?
    else {
        return Ok(None);
    };
    let saved: Preference = serde_json::from_slice(&bytes).map_err(|_| model::invalid())?;
    if saved.version != 1
        || saved.workspace_id != controller.store.workspace_id
        || !model::opaque(&saved.user_id)
        || !["browser", "accessibility", "desktop"].contains(&saved.surface.as_str())
    {
        return Err(model::invalid());
    }
    Ok(Some(saved))
}

pub(crate) fn remember(controller: &Controller, user: &str, surface: &str) -> Result<()> {
    private_config::atomic_private(
        &controller
            .store
            .directory
            .join("computer/local-surface.json"),
        &serde_json::to_vec(&Preference {
            version: 1,
            workspace_id: controller.store.workspace_id.clone(),
            user_id: user.into(),
            surface: surface.into(),
        })
        .map_err(|_| model::invalid())?,
    )
}

// Only replay a local preference under a current owner's full grant on this
// hardware. The worker independently rechecks OS permissions before switching.
pub(crate) async fn restore(
    controller: &Arc<Controller>,
    target: &Arc<Target>,
    authorize: Authority,
) -> Result<()> {
    if !controller
        .runtime
        .local_desktop
        .as_ref()
        .is_some_and(|c| c.host_control)
    {
        return Ok(());
    }
    let preference = load(controller)?;
    let surface = preference
        .as_ref()
        .map_or("accessibility", |p| p.surface.as_str());
    if surface == "browser" {
        return Ok(());
    }
    let Some(expected) =
        authorization::local_grant(controller, preference.as_ref().map(|p| p.user_id.as_str()))
            .await?
    else {
        return Ok(());
    };
    let state = target.state().await;
    let ready = if surface == "accessibility" {
        target.saved.has(model::MACOS_ACCESSIBILITY)
            && state["desktop"]["accessibilityReady"] == true
    } else {
        target.saved.has(model::HOST_DESKTOP)
            && state["desktop"]["available"] == true
            && state["desktop"]["authorized"] == true
    };
    if !ready {
        return Ok(());
    }
    let user = expected.0.clone();
    let weak = Arc::downgrade(controller);
    let check: Authority = Arc::new(move || {
        let (weak, expected, authorize) = (weak.clone(), expected.clone(), authorize.clone());
        Box::pin(async move {
            authorize().await?;
            let controller = weak.upgrade().ok_or_else(model::invalid)?;
            controller.active()?;
            if authorization::local_grant(&controller, Some(&expected.0)).await? != Some(expected) {
                return Err(model::invalid());
            }
            Ok(())
        })
    });
    // A permission changed between the probe and switch must not prevent shell
    // access. Leave native control disabled and expose current OS readiness.
    if target
        .request(
            Request::post("/surface", &json!({"surface":surface,"confirm":true})),
            check.clone(),
        )
        .await
        .is_ok()
    {
        check().await?;
        if preference.is_none() {
            remember(controller, &user, surface)?;
        }
    }
    target.request(Request::get("/health"), check).await?;
    Ok(())
}
