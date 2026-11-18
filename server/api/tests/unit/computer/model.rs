use super::*;

#[test]
fn shared_mac_apps_keep_their_own_permission_and_do_not_authorize_the_host_desktop() {
    let workspace = uuid::Uuid::new_v4().to_string();
    let worker = json!({
        "protocol":PROTOCOL,"instanceId":uuid::Uuid::new_v4().to_string(),
        "workspaceScopeId":workspace,"name":"Local Mac","platform":"darwin",
        "surface":"accessibility","capabilities":[SHARED_SCREEN,MACOS_ACCESSIBILITY],
        "desktop":{"kind":"host","accessibilityAvailable":true,"accessibilityReady":true,
            "accessibilityPermission":"granted",
            "permissions":{"accessibility":"denied","screenRecording":"denied"}},
    });
    let inspect = |value| {
        health(
            value,
            "http://127.0.0.1:52190",
            &"a".repeat(48),
            &workspace,
            None,
            None,
            None,
            None,
        )
    };
    let accepted = inspect(worker.clone()).unwrap();
    assert!(accepted.saved.has(MACOS_ACCESSIBILITY));
    assert!(!accepted.saved.has(HOST_DESKTOP));
    assert_eq!(accepted.state["desktop"]["accessibilityReady"], true);
    assert_eq!(
        accepted.state["desktop"]["permissions"]["accessibility"],
        "denied"
    );

    let mut denied = worker.clone();
    denied["desktop"]["accessibilityPermission"] = json!("denied");
    denied["desktop"]["permissions"]["accessibility"] = json!("granted");
    assert_eq!(
        inspect(denied).unwrap().state["desktop"]["accessibilityReady"],
        false
    );

    let mut unauthorized = worker;
    unauthorized["surface"] = json!("desktop");
    assert!(inspect(unauthorized).is_err());
}
