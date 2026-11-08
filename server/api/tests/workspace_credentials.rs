use openbot_backend::workspace::{Table, WorkspaceRegistry, WorkspaceStore, model};
use serde_json::json;
use std::sync::Arc;

async fn original() -> (
    tempfile::TempDir,
    String,
    WorkspaceRegistry,
    Arc<WorkspaceStore>,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let wid = uuid::Uuid::new_v4().to_string();
    let registry = WorkspaceRegistry::new(dir.path().to_owned());
    let store = registry.get(&wid, &wid).await.unwrap();
    let id = model::runtime_config(&store).await.unwrap()["profileId"]
        .as_str()
        .unwrap()
        .to_owned();
    (dir, wid, registry, store, id)
}

#[tokio::test]
async fn legacy_keys_migrate_to_private_file_and_survive_restart_without_sqlite_secrets() {
    let (dir, wid, registry, store, id) = original().await;
    let mut profile = store
        .get(Table::Settings, &format!("model-profile:{id}"))
        .await
        .unwrap()
        .unwrap();
    profile["provider"] = json!("openai");
    profile["baseUrl"] = json!("https://model.example.test/v1");
    store.put(Table::Settings, &profile).await.unwrap();
    store.put(Table::Settings,&json!({"id":format!("model-profile-secret:{id}"),"provider":"openai","baseUrl":"https://model.example.test/v1","apiKey":"SYNTHETIC_MIGRATED_KEY"})).await.unwrap();
    registry.close().await;
    let next = WorkspaceRegistry::new(dir.path().to_owned());
    let migrated = next.get(&wid, &wid).await.unwrap();
    assert_eq!(
        model::runtime_config(&migrated).await.unwrap()["apiKey"],
        "SYNTHETIC_MIGRATED_KEY"
    );
    let rows = migrated.list(Table::Settings).await.unwrap();
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("SYNTHETIC_MIGRATED_KEY")
    );
    assert!(rows.iter().all(|row| {
        !row["id"]
            .as_str()
            .unwrap()
            .starts_with("model-profile-secret:")
    }));
    let file = migrated.directory.join("config/models.private.json");
    assert!(
        std::fs::read_to_string(&file)
            .unwrap()
            .contains("SYNTHETIC_MIGRATED_KEY")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    next.close().await;
    let restarted = WorkspaceRegistry::new(dir.path().to_owned());
    let resumed = restarted.get(&wid, &wid).await.unwrap();
    assert_eq!(
        model::runtime_config(&resumed).await.unwrap()["apiKey"],
        "SYNTHETIC_MIGRATED_KEY"
    );
    restarted.close().await;
    let destination = tempfile::tempdir().unwrap();
    let relocated = destination.path().join("relocated-data");
    std::fs::rename(dir.path(), &relocated).unwrap();
    let moved = WorkspaceRegistry::new(relocated);
    let restored = moved.get(&wid, &wid).await.unwrap();
    assert_eq!(
        model::runtime_config(&restored).await.unwrap()["apiKey"],
        "SYNTHETIC_MIGRATED_KEY"
    );
    moved.close().await;
}

#[tokio::test]
async fn failed_private_publication_preserves_legacy_row_and_public_profile_transaction() {
    let (dir, wid, registry, store, id) = original().await;
    let profile = store
        .get(Table::Settings, &format!("model-profile:{id}"))
        .await
        .unwrap()
        .unwrap();
    let secret = json!({"id":format!("model-profile-secret:{id}"),"provider":profile["provider"],"baseUrl":profile["baseUrl"],"apiKey":"SYNTHETIC_ROLLBACK_KEY"});
    store.put(Table::Settings, &secret).await.unwrap();
    let directory = store.directory.clone();
    registry.close().await;
    std::fs::write(directory.join("config"), b"not a directory").unwrap();
    let next = WorkspaceRegistry::new(dir.path().to_owned());
    assert!(next.get(&wid, &wid).await.is_err());
    let raw = WorkspaceStore::open(&directory).await.unwrap();
    assert_eq!(
        raw.get(Table::Settings, secret["id"].as_str().unwrap())
            .await
            .unwrap(),
        Some(secret)
    );
    assert_eq!(
        raw.get(Table::Settings, &format!("model-profile:{id}"))
            .await
            .unwrap(),
        Some(profile)
    );
    raw.close().await;
    next.close().await;
}

#[tokio::test]
async fn private_reference_is_bound_to_workspace_profile_provider_and_endpoint() {
    let (dir, wid, registry, store, id) = original().await;
    let profile = store
        .get(Table::Settings, &format!("model-profile:{id}"))
        .await
        .unwrap()
        .unwrap();
    store.put(Table::Settings,&json!({"id":format!("model-profile-secret:{id}"),"provider":profile["provider"],"baseUrl":profile["baseUrl"],"apiKey":"SYNTHETIC_BOUND_KEY"})).await.unwrap();
    registry.close().await;
    let next = WorkspaceRegistry::new(dir.path().to_owned());
    let store = next.get(&wid, &wid).await.unwrap();
    let saved = store
        .get(Table::Settings, &format!("model-profile:{id}"))
        .await
        .unwrap()
        .unwrap();
    for (field, value) in [
        ("provider", "different"),
        ("baseUrl", "https://other.example.test/v1"),
    ] {
        let mut altered = saved.clone();
        altered[field] = json!(value);
        store.put(Table::Settings, &altered).await.unwrap();
        assert_eq!(model::runtime_config(&store).await.unwrap()["apiKey"], "");
    }
    store.put(Table::Settings, &saved).await.unwrap();
    assert_eq!(
        model::runtime_config(&store).await.unwrap()["apiKey"],
        "SYNTHETIC_BOUND_KEY"
    );
    let other = uuid::Uuid::new_v4().to_string();
    let target = next.get(&other, &other).await.unwrap();
    for row in store.list(Table::Settings).await.unwrap() {
        target.put(Table::Settings, &row).await.unwrap();
    }
    std::fs::create_dir(target.directory.join("config")).unwrap();
    std::fs::copy(
        store.directory.join("config/models.private.json"),
        target.directory.join("config/models.private.json"),
    )
    .unwrap();
    assert_eq!(model::runtime_config(&target).await.unwrap()["apiKey"], "");
    next.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn private_configuration_refuses_symlink_and_world_readable_files() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (dir, wid, registry, store, id) = original().await;
    let profile = store
        .get(Table::Settings, &format!("model-profile:{id}"))
        .await
        .unwrap()
        .unwrap();
    store.put(Table::Settings,&json!({"id":format!("model-profile-secret:{id}"),"provider":profile["provider"],"baseUrl":profile["baseUrl"],"apiKey":"SYNTHETIC_PRIVATE_KEY"})).await.unwrap();
    registry.close().await;
    let next = WorkspaceRegistry::new(dir.path().to_owned());
    let store = next.get(&wid, &wid).await.unwrap();
    let config = store.directory.join("config");
    let file = config.join("models.private.json");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(model::runtime_config(&store).await.is_err());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let moved = store.directory.join("original-config");
    std::fs::rename(&config, &moved).unwrap();
    symlink(&moved, &config).unwrap();
    assert!(model::runtime_config(&store).await.is_err());
    next.close().await;
}
