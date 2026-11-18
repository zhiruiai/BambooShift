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
