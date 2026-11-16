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
mod tests {
    use super::*;
    fn local() -> Value {
        json!({"connected":true,"mode":"remote","platform":"darwin","surface":"browser",
            "desktop":{"accessibilityReady":false},"capabilities":["local-shell-v1"],
            "targetRevision":uuid::Uuid::new_v4().to_string()})
    }
    #[test]
    fn local_app_open_requires_current_local_mac_opt_in_and_shell_capability() {
        let status = local();
        let action = plan(&json!("com.google.Chrome"), &status, true, true).unwrap();
        assert_eq!(action["command"], "/usr/bin/open -b 'com.google.Chrome'");
        assert_eq!(action["expectedTargetRevision"], status["targetRevision"]);
        for (local, opted) in [(false, true), (true, false)] {
            assert_eq!(
                plan(&json!("com.google.Chrome"), &status, local, opted).unwrap()["type"],
                computer::accessibility::OPEN
            );
        }
        for (key, value) in [
            ("connected", json!(false)),
            ("platform", json!("linux")),
            ("capabilities", json!([])),
        ] {
            let mut unavailable = status.clone();
            unavailable[key] = value;
            assert_eq!(
                plan(&json!("com.google.Chrome"), &unavailable, true, true).unwrap()["type"],
                computer::accessibility::OPEN
            );
        }
    }
    #[test]
    fn native_app_open_is_preferred_and_bundle_injection_or_self_control_is_rejected() {
        let mut ready = local();
        ready["surface"] = json!("accessibility");
        ready["desktop"]["accessibilityReady"] = json!(true);
        ready["capabilities"] = json!(["local-shell-v1", computer::model::MACOS_APP_LAUNCH]);
        assert_eq!(
            plan(&json!("com.google.Chrome"), &ready, true, true).unwrap()["type"],
            computer::accessibility::OPEN
        );
        for bundle in [
            "com.google.Chrome';touch /tmp/injected;#",
            "com.google.$(id)",
            "com.google.`id`",
            "com.google.Chrome\n",
            "com..Chrome",
            "-a",
            "Chrome",
            "com.openbot.client",
            "COM.OPENBOT.desktop-helper",
            "com.openbot.client.helper",
        ] {
            assert!(
                plan(&json!(bundle), &local(), true, true).is_err(),
                "{bundle}"
            );
        }
    }
}
