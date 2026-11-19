use openbot_backend::workspace::{Table, WorkspaceRegistry, WorkspaceStore};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn workspace_registry_is_lazy_isolated_and_reopens_existing_json() {
    let directory = tempfile::tempdir().unwrap();
    let registry = WorkspaceRegistry::new(directory.path().to_owned());
    let a = uuid::Uuid::new_v4().to_string();
    let b = uuid::Uuid::new_v4().to_string();
    assert!(!directory.path().join("spaces").exists());
    let first = registry.get(&a, &a).await.unwrap();
    let same = registry.get(&a, &a).await.unwrap();
    assert!(Arc::ptr_eq(&first, &same));
    first
        .put(
            Table::Memories,
            &json!({"id":"private","agentId":"a","content":"Synthetic private content"}),
        )
        .await
        .unwrap();
    let second = registry.get(&b, &b).await.unwrap();
    assert!(
        second
            .get(Table::Memories, "private")
            .await
            .unwrap()
            .is_none()
    );
    assert!(registry.get(&a, "../outside").await.is_err());
    assert!(registry.get(&a, "legacy").await.is_err());
    registry.close().await;
    assert!(registry.get(&a, &a).await.is_err());
    let reopened = WorkspaceRegistry::new(directory.path().to_owned());
    let first = reopened.get(&a, &a).await.unwrap();
    assert_eq!(
        first
            .get(Table::Memories, "private")
            .await
            .unwrap()
            .unwrap()["content"],
        "Synthetic private content"
    );
    reopened.close().await;
}
#[tokio::test]
async fn rollback_is_atomic_and_events_only_announce_committed_state() {
    let directory = tempfile::tempdir().unwrap();
    let store = WorkspaceStore::open(directory.path()).await.unwrap();
    let mut receive = store.subscribe();
    let mut tx = store.begin().await.unwrap();
    WorkspaceStore::put_in(&mut tx, Table::Agents, &json!({"id":"a","name":"draft"}))
        .await
        .unwrap();
    WorkspaceStore::put_in(
        &mut tx,
        Table::Conversations,
        &json!({"id":"c","agentIds":["a"]}),
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    assert!(store.get(Table::Agents, "a").await.unwrap().is_none());
    assert!(store.list(Table::Conversations).await.unwrap().is_empty());
    assert!(receive.try_recv().is_err());
    let mut tx = store.begin().await.unwrap();
    WorkspaceStore::put_in(
        &mut tx,
        Table::Memories,
        &json!({"id":"m","content":"verified"}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    store.emit("update", json!({}));
    let event = receive.recv().await.unwrap();
    assert_eq!(event.event, "update");
    assert_eq!(event.data, json!({}));
    assert_eq!(event.revision, 1);
    assert_eq!(store.sync()["revision"], 1);
    store.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn registry_rejects_symlink_directories_and_database_hardlinks() {
    use std::os::unix::{fs::PermissionsExt, fs::symlink};
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let wid = uuid::Uuid::new_v4().to_string();
    let registry = WorkspaceRegistry::new(directory.path().to_owned());
    symlink(outside.path(), directory.path().join("spaces")).unwrap();
    assert!(registry.get(&wid, &wid).await.is_err());
    std::fs::remove_file(directory.path().join("spaces")).unwrap();
    let store = registry.get(&wid, &wid).await.unwrap();
    let file = store.directory.join("openbot.sqlite");
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    registry.close().await;
    std::fs::hard_link(&file, outside.path().join("linked.sqlite")).unwrap();
    let registry = WorkspaceRegistry::new(directory.path().to_owned());
    assert!(registry.get(&wid, &wid).await.is_err());
}

#[tokio::test]
async fn waiting_writers_leave_connections_for_membership_checks() {
    use std::time::Duration;
    use tokio::{
        sync::Barrier,
        task::JoinSet,
        time::{sleep, timeout},
    };

    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(WorkspaceStore::open(directory.path()).await.unwrap());
    let agent = json!({"id":"agent-1","name":"Scheduler"});
    let conversation = json!({"id":"chat-1","agentIds":["agent-1"]});
    store.put(Table::Agents, &agent).await.unwrap();
    store
        .put(Table::Conversations, &conversation)
        .await
        .unwrap();
    let active = store.begin().await.unwrap();
    let ready = Arc::new(Barrier::new(7));
    let mut queued = JoinSet::new();
    for _ in 0..6 {
        let store = Arc::clone(&store);
        let ready = Arc::clone(&ready);
        queued.spawn(async move {
            ready.wait().await;
            store.begin().await.unwrap().commit().await.unwrap();
        });
    }
    ready.wait().await;
    // Allow each competing writer to reach BEGIN IMMEDIATE.
    sleep(Duration::from_millis(200)).await;
    timeout(Duration::from_secs(1), async {
        let chat = store
            .get(Table::Conversations, "chat-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(chat["agentIds"], conversation["agentIds"]);
        assert_eq!(
            store.get(Table::Agents, "agent-1").await.unwrap(),
            Some(agent)
        );
    })
    .await
    .expect("A writer must be able to recheck membership before commit");
    active.commit().await.unwrap();
    while let Some(done) = queued.join_next().await {
        done.unwrap();
    }
}
