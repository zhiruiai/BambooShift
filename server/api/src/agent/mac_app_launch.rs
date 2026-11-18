use crate::{
    computer::{
        self,
        controller::Controller,
        transport::{Authority, Request},
    },
    error::{Result, only_fields},
};
use serde_json::{Value, json};
use std::sync::Arc;

fn plan(bundle: &Value, status: &Value, local: bool, opted_in: bool) -> Result<Value> {
    // Reuse native app validation, including the protected BambooShift IDs.
    // Its ASCII bundle grammar excludes all shell metacharacters and quotes.
    let mut action = computer::validation::action(
        &json!({"type":computer::accessibility::OPEN,"bundleId":bundle}),
        false,
    )?;
    let has = |capability: &str| {
        status["capabilities"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == capability))
    };
    let native = status["surface"] == "accessibility"
        && status["desktop"]["accessibilityReady"] == true
        && has(computer::model::MACOS_APP_LAUNCH);
    if !native
        && local
        && opted_in
        && status["connected"] == true
        && status["platform"] == "darwin"
        && has("local-shell-v1")
    {
        let bundle = action["bundleId"].as_str().unwrap();
        action = json!({"type":"local_shell","path":".",
            "command":format!("/usr/bin/open -b '{bundle}'")});
    }
    // The existing request pipeline must reject a target switch between this
    // decision and approval/execution, rather than forwarding to another machine.
    action["expectedTargetRevision"] = status["targetRevision"].clone();
    Ok(action)
}

pub(super) async fn action(
    controller: &Arc<Controller>,
    agent: &str,
    args: &Value,
    authorize: Authority,
) -> Result<Value> {
    only_fields(args, &["type", "bundleId"])?;
    let target = computer::controls::target(controller, Some(agent), authorize.clone()).await?;
    target.request(Request::get("/health"), authorize).await?;
    let status = target.state().await;
    let opted_in = cfg!(target_os = "macos")
        && controller
            .runtime
            .local_desktop
            .as_ref()
            .is_some_and(|config| config.host_control);
    // Target health normalizes mode to remote even for its local transport.
    // Bind locality to the spawned executor, never to the worker's mode label.
    let local = controller.is_local().await
        && controller
            .local
            .lock()
            .await
            .as_ref()
            .is_some_and(|executor| {
                executor.url == target.saved.url && executor.token == target.saved.token
            });
    plan(&args["bundleId"], &status, local, opted_in)
}

#[cfg(test)]
#[path = "../../tests/unit/agent/mac_app_launch.rs"]
mod tests;
