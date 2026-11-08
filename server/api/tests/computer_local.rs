mod workspace_support;
use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn real_local_executor_supports_bounded_readonly_commands_without_host_desktop_or_shell() {
    let f = Fixture::new().await;
    let (status, connected) = f
        .request(
            "POST",
            &f.path("/computer/connect"),
            Some(json!({"mode":"local"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{connected}");
    assert_eq!(connected["mode"], "local");
    assert_eq!(connected["connected"], true);
    assert_eq!(connected["desktop"]["authorized"], false);
    assert!(!connected.to_string().contains("token"));
    let (status, action) = f
        .request(
            "POST",
            &f.path("/computer/actions"),
            Some(json!({"type":"terminal_command","command":"uname"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{action}");
    assert_eq!(action["status"], "done", "{action}");
    assert!(
        action["result"]["stdout"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/computer/actions"),
            Some(json!({"type":"remote_shell","command":"echo not-allowed"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/computer/surface"),
            Some(json!({"surface":"desktop","confirm":true})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        403
    );
    let (status, disconnected) = f
        .request(
            "POST",
            &f.path("/computer/disconnect"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{disconnected}");
    assert_eq!(disconnected["connected"], false);
    f.state.close().await;
}

#[tokio::test]
async fn restarted_default_operation_requires_explicit_new_executor_before_future_commands() {
    let mut f = Fixture::new().await;
    f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    openbot_backend::computer::action_store::persist(
        &store,
        &json!({"id":id,"action":{"id":id,"status":"running","type":"write_file"},"context":{}}),
    )
    .await
    .unwrap();
    f.state.close().await;
    f.state = openbot_backend::db::State::open(openbot_backend::config::Config::local(
        f.directory.path(),
    ))
    .await
    .unwrap();
    let (_, status) = f
        .request(
            "GET",
            &f.path("/computer/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status["connected"], false);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/computer/actions"),
            Some(json!({"type":"terminal_command","command":"pwd"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    let (code, connected) = f
        .request(
            "POST",
            &f.path("/computer/connect"),
            Some(json!({"mode":"local"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{connected}");
    assert_eq!(connected["connected"], true);
    let (code, result) = f
        .request(
            "POST",
            &f.path("/computer/actions"),
            Some(json!({"type":"terminal_command","command":"pwd"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{result}");
    assert_eq!(result["status"], "done");
    f.state.close().await;
}
