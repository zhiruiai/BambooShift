use super::*;
use crate::config::{Config, LocalDesktopConfig};
use std::collections::BTreeMap;

#[test]
fn local_worker_preserves_browser_options_without_inheriting_other_environment() {
    let directory = tempfile::tempdir().unwrap();
    let bundle = directory.path().join("packages/computer-worker");
    std::fs::create_dir_all(&bundle).unwrap();
    std::fs::write(bundle.join("index.mjs"), "").unwrap();
    let mut config = Config::local(directory.path().join("data"));
    config.runtime_dir = directory.path().to_owned();
    config.node_binary = std::env::current_exe().unwrap();
    let supplied = BTreeMap::from([
        ("PATH", "/synthetic/bin"),
        (
            "OPENBOT_BROWSER_EXECUTABLE",
            "/synthetic/Chromium.app/browser",
        ),
        ("OPENBOT_BROWSER_HEADLESS", "false"),
        (
            "OPENBOT_BROWSER_ALLOWED_ORIGINS",
            "http://synthetic.invalid",
        ),
        ("SYNTHETIC_MODEL_SECRET", "must-not-inherit"),
        ("HOME", "/synthetic/home"),
        ("USER", "synthetic"),
        ("LOGNAME", "synthetic"),
        ("TMPDIR", "/synthetic/tmp"),
        ("LANG", "en_US.UTF-8"),
    ]);
    for host_control in [false, true] {
        config.local_desktop = Some(LocalDesktopConfig {
            bootstrap_token: "a".repeat(64),
            host_control,
            desktop_driver: None,
            accessibility_helper: None,
        });
        let command =
            worker_command(&config, |name| supplied.get(name).map(OsString::from)).unwrap();
        let actual: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| (key.to_str().unwrap(), value.unwrap().to_str().unwrap()))
            .collect();
        assert_eq!(
            actual["OPENBOT_BROWSER_EXECUTABLE"],
            supplied["OPENBOT_BROWSER_EXECUTABLE"]
        );
        assert_eq!(actual["OPENBOT_BROWSER_HEADLESS"], "false");
        assert_eq!(actual["PATH"], "/synthetic/bin");
        assert!(!actual.contains_key("OPENBOT_BROWSER_ALLOWED_ORIGINS"));
        assert!(!actual.contains_key("SYNTHETIC_MODEL_SECRET"));
        assert_eq!(actual.contains_key("HOME"), host_control);
        assert_eq!(actual.len(), if host_control { 8 } else { 4 });
    }
    let defaults = worker_command(&config, |_| None).unwrap();
    let names: Vec<_> = defaults.as_std().get_envs().map(|(key, _)| key).collect();
    assert_eq!(names, ["LANG", "PATH"]);
}
