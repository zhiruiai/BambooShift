use openbot_backend::config::Config;
use serde_json::json;

#[test]
fn private_configuration_is_explicit_and_rejects_unsafe_permissions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.json");
    std::fs::write(&path,json!({"dataDir":directory.path().join("isolated-data"),"bind":"127.0.0.1:0","publicOrigin":"https://bots.example.test"}).to_string()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Config::from_private_file(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let alias = directory.path().join("alias.json");
        symlink(&path, &alias).unwrap();
        assert!(Config::from_private_file(&alias).is_err());
    }
    let config = Config::from_private_file(&path).unwrap();
    assert_eq!(
        config.public_origin.as_deref(),
        Some("https://bots.example.test")
    );
    assert_eq!(config.bind.port(), 0);
    let mut external = config.clone();
    external.bind = "0.0.0.0:3002".parse().unwrap();
    assert!(external.validate().is_err());
    let mut invalid = config;
    invalid.public_origin = Some("https://user:password@example.test".into());
    assert!(invalid.validate().is_err());
}
