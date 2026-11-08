use super::*;

#[tokio::test]
async fn interrupted_local_bot_action_recovers_as_shared_scope_and_requires_new_executor() {
    let mut group = Group::new().await;
    local(&group).await;
    let id = uuid::Uuid::new_v4().to_string();
    computer::action_store::persist(&group.store, &json!({"id":id,"action":{"id":id,"type":"write_file","status":"running"},"context":{"agentId":group.ids[0]},"recoveryScope":"default"})).await.unwrap();
    group.f.state.close().await;
    group.f.state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        group.f.directory.path(),
    ))
    .await
    .unwrap();
    group.store = group
        .f
        .state
        .workspace
        .get(&group.f.workspace, &group.f.workspace)
        .await
        .unwrap();
    let current = task_status(&group, &group.ids[1]).await;
    assert_eq!(current["connected"], false);
    assert_eq!(current["botScreen"]["task"]["status"], "blocked");
    assert_eq!(
        group
            .f
            .request(
                "POST",
                &group
                    .f
                    .path(&format!("/computer/bots/{}/actions", group.ids[1])),
                Some(json!({"type":"terminal_command","command":"pwd"})),
                false,
                Some(&group.f.owner)
            )
            .await
            .0,
        409
    );
    local(&group).await;
    assert_eq!(task_status(&group, &group.ids[1]).await["connected"], true);
    assert_eq!(
        computer::action_store::raw(&group.store, &id)
            .await
            .unwrap()["recoveryRequired"],
        0
    );
    group.close().await;
}

#[tokio::test]
async fn unknown_local_cleanup_blocks_every_bot_and_persists_until_new_executor() {
    let mut group = Group::new().await;
    local(&group).await;
    let controller = group
        .f
        .state
        .computer
        .get(&group.f.state, group.store.clone())
        .await
        .unwrap();
    let allowed = authority(Arc::new(AtomicBool::new(true)));
    let lease = computer::tasks::acquire(
        &controller,
        &group.ids[0],
        &group.cid,
        "synthetic-uncertain-root",
        allowed.clone(),
    )
    .await
    .unwrap();
    let target = computer::controls::target(&controller, Some(&group.ids[0]), allowed)
        .await
        .unwrap();
    target.poison();
    assert!(lease.finish().await.is_err());
    assert_eq!(
        task_status(&group, &group.ids[1]).await["botScreen"]["task"]["status"],
        "blocked"
    );
    group.f.state.close().await;
    group.f.state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        group.f.directory.path(),
    ))
    .await
    .unwrap();
    group.store = group
        .f
        .state
        .workspace
        .get(&group.f.workspace, &group.f.workspace)
        .await
        .unwrap();
    assert_eq!(
        task_status(&group, &group.ids[2]).await["botScreen"]["task"]["status"],
        "blocked"
    );
    local(&group).await;
    assert_eq!(
        task_status(&group, &group.ids[2]).await["botScreen"]["task"]["status"],
        "idle"
    );
    group.close().await;
}
