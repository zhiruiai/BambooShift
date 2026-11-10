mod agent_computer_support;
mod agent_delegation_support;
mod computer_support;
mod workspace_support;

use agent_computer_support::*;
use axum::{Router, response::Html, routing::get};
use serde_json::json;
use std::{
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn standalone_worker_runs_bot_operations_without_a_screen_pool() {
    let group = Group::new().await;
    let f = &group.f;
    let agent = &group.ids[0];
    let runtime = &f.state.config.runtime_dir;
    let node = std::env::var_os("OPENBOT_NODE").unwrap_or_else(|| "node".into());
    let workspace = f.directory.path().join("standalone/workspace");
    let token = "synthetic-standalone-token-for-test";
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("lesson.txt"), "Moon phases exercise").unwrap();
    let page = if std::env::var("OPENBOT_BROWSER_TEST").as_deref() == Ok("1") {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let visited = Arc::new(AtomicUsize::new(0));
        let counter = visited.clone();
        let app = Router::new().route(
            "/",
            get(move || async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Html("<title>Moon Lab</title><h1>Draw the waxing crescent.</h1>")
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Some((origin, visited, task))
    } else {
        None
    };
    let mut command = Command::new(node);
    command.env_clear();
    if let Some((origin, _, _)) = &page {
        command.env("OPENBOT_BROWSER_ALLOWED_ORIGINS", origin);
    }
    if let Some(executable) = std::env::var_os("OPENBOT_BROWSER_EXECUTABLE") {
        command.env("OPENBOT_BROWSER_EXECUTABLE", executable);
    }
    let mut worker = command
        .current_dir(runtime)
        .args(["--import", "tsx", "scripts/computer-worker.ts"])
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("OPENBOT_WORKER_TOKEN", token)
        .env("OPENBOT_WORKER_PORT", "0")
        .env("OPENBOT_WORKER_WORKSPACE_ID", &f.workspace)
        .env("OPENBOT_WORKER_WORKSPACE", &workspace)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(worker.stdout.take().unwrap()).lines();
    let ready = tokio::time::timeout(Duration::from_secs(15), stdout.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let url = ready.strip_prefix("OpenBot Computer Worker: ").unwrap();
    let (code, pairing) = f
        .request(
            "POST",
            &f.path("/computer/connect/check"),
            Some(json!({"url":url,"token":token})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{pairing}");
    assert_eq!(
        pairing,
        json!({"topology":"shared","browser":"supported","desktop":"unavailable"})
    );
    let connect = json!({"mode":"remote","url":url,"token":token});
    let (code, connected) = f
        .request(
            "POST",
            &f.path("/computer/connect"),
            Some(connect.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{connected}");
    assert_eq!(connected["executionLocation"], "remote");

    let foreign = format!("/api/workspaces/{}/computer/connect", f.foreign);
    let (code, _) = f
        .request("POST", &foreign, Some(connect), true, Some(&f.member))
        .await;
    assert_eq!(code, 409);

    let base = f.path(&format!("/computer/bots/{agent}"));
    let (code, prepared) = f
        .request(
            "POST",
            &format!("{base}/prepare"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{prepared}");
    assert_eq!(prepared["targetRevision"], connected["targetRevision"]);
    assert_eq!(prepared["botScreen"]["shared"], true);
    assert_eq!(prepared["botScreen"]["status"], "ready");
    assert!(prepared["botScreen"]["screenId"].is_null());

    let (code, action) = f
        .request(
            "POST",
            &format!("{base}/actions"),
            Some(json!({"type":"read_file","path":"lesson.txt"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{action}");
    assert_eq!(action["status"], "done");
    assert_eq!(action["result"]["content"], "Moon phases exercise");

    let (code, inventory) = f
        .request(
            "GET",
            &f.path("/computer/bots"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{inventory}");
    assert_eq!(inventory["capacity"]["ready"], 1);
    assert_eq!(inventory["shared"], true);
    assert_eq!(inventory["bots"][0]["shared"], true);
    if let Some((origin, visited, page_task)) = page {
        let model = Model::new(Arc::new(move |body| {
            let url = origin.clone();
            Box::pin(async move {
                if has_tool_result(&body) {
                    let outcome = tool_result(&body);
                    assert_eq!(outcome["status"], "done", "{outcome}");
                    assert_eq!(outcome["result"]["title"], "Moon Lab");
                    assert_eq!(outcome["result"]["text"], "Draw the waxing crescent.");
                    finish("Read the moon exercise from the work computer.")
                } else {
                    call(
                        "computer_action",
                        json!({"type":"browser_navigate","url":url}),
                    )
                }
            })
        }))
        .await;
        configured(&group, &model, false).await;
        let input = group
            .send(
                "Open the moon exercise in the work browser.",
                "followUp",
                false,
            )
            .await;
        let action = pending(&group).await;
        assert_eq!(visited.load(Ordering::SeqCst), 0);
        assert_eq!(approve(&group, &action, true).await.0, 403);
        assert_eq!(approve(&group, &action, false).await.0, 200);
        let messages = group.done_within(Duration::from_secs(55)).await;
        assert_eq!(root_result(&messages, &input)["status"], "done");
        assert_eq!(visited.load(Ordering::SeqCst), 1);
        assert_eq!(approve(&group, &action, false).await.0, 409);
        page_task.abort();
    }
    group.close().await;
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(worker.id().unwrap() as i32, libc::SIGTERM);
        }
        if tokio::time::timeout(Duration::from_secs(15), worker.wait())
            .await
            .is_ok()
        {
            return;
        }
    }
    worker.kill().await.unwrap();
}
