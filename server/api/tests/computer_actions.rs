mod computer_support;
mod workspace_support;
use computer_support::*;
use openbot_backend::{computer, workspace::access};
use serde_json::{Value, json};
use std::time::Duration;
use workspace_support::Fixture;
fn headers(cookie: &str, user: &str) -> axum::http::HeaderMap {
    let mut h = axum::http::HeaderMap::new();
    h.insert(
        "cookie",
        format!("openbot_account={cookie}").parse().unwrap(),
    );
    h.insert("x-openbot-expected-user", user.parse().unwrap());
    h
}
async fn fixture() -> (Fixture, Server, Value) {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    (f, s, data)
}
#[tokio::test]
async fn member_requester_approval_creates_real_frame_without_owner_override_or_secret_leak() {
    let (f, s, data) = fixture().await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    let chat = data["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["agentIds"].as_array().unwrap().iter().any(|a| a == agent))
        .unwrap();
    prepared(&f, agent).await;
    let path = f.path(&format!("/computer/bots/{agent}/actions"));
    let (status, action) = f
        .request(
            "POST",
            &path,
            Some(json!({"type":"browser_click","selector":"#export","conversationId":chat["id"]})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200, "{action}");
    assert_eq!(action["status"], "pending");
    assert_eq!(action["requester"]["userId"], f.member);
    let decision = format!("{}/{}/approve", path, action["id"].as_str().unwrap());
    assert_eq!(
        f.request("POST", &decision, Some(json!({})), false, Some(&f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        f.request("POST", &decision, Some(json!({})), true, Some(&f.member))
            .await
            .0,
        200
    );
    let done = settled(&f, action["id"].as_str().unwrap()).await;
    assert_eq!(done["status"], "done", "{done}");
    assert_eq!(done["frame"]["mimeType"], "image/webp");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let image = computer::frames::read(&store, done["frame"]["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(&image[8..12], b"WEBP");
    let cards = f.bootstrap().await["messages"].clone();
    let card = cards
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["metadata"]["action"]["id"] == action["id"])
        .unwrap();
    assert_eq!(card["metadata"]["action"]["status"], "done");
    assert!(!cards.to_string().contains(TOKEN));
    assert!(!cards.to_string().contains("base64"));
    assert_eq!(
        f.request("POST", &decision, Some(json!({})), true, Some(&f.member))
            .await
            .0,
        409
    );
    assert_eq!(
        s.worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(p, _)| p.ends_with("/execute-with-frame"))
            .count(),
        1
    );
    f.state.close().await;
}
#[tokio::test]
async fn file_transfer_pins_library_digest_and_imports_remote_file_into_same_workspace() {
    let (f, s, data) = fixture().await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    prepared(&f, agent).await;
    let (_, file) = f
        .request(
            "POST",
            &f.path("/files"),
            Some(json!({"name":"source.txt","content":"b3JpZ2luYWw=","type":"text/plain"})),
            false,
            Some(&f.owner),
        )
        .await;
    let endpoint = f.path(&format!("/computer/bots/{agent}/actions"));
    let (_, action) = f
        .request(
            "POST",
            &endpoint,
            Some(json!({"type":"upload_file","fileId":file["id"],"path":"uploaded.txt"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(action["payload"]["size"], 8, "{action}");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    std::fs::write(
        store
            .directory
            .join("workspace")
            .join(file["name"].as_str().unwrap()),
        b"changed!",
    )
    .unwrap();
    let decision = format!("{}/{}/approve", endpoint, action["id"].as_str().unwrap());
    assert_eq!(
        f.request("POST", &decision, Some(json!({})), false, Some(&f.owner))
            .await
            .0,
        200
    );
    let done = settled(&f, action["id"].as_str().unwrap()).await;
    assert_eq!(done["status"], "error");
    assert!(!s.worker.files.lock().await.contains_key("uploaded.txt"));
    let (status, download) = f
        .request(
            "POST",
            &endpoint,
            Some(json!({"type":"download_file","path":"report.txt"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{download}");
    assert_eq!(download["status"], "done", "{download}");
    let imported = store
        .get(
            openbot_backend::workspace::Table::Files,
            download["result"]["fileId"].as_str().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(imported["source"]["kind"], "computer");
    assert_eq!(
        std::fs::read(
            store
                .directory
                .join("workspace")
                .join(imported["name"].as_str().unwrap())
        )
        .unwrap(),
        b"remote report"
    );
    f.state.close().await;
}
#[tokio::test]
async fn takeover_cancels_approval_and_virtual_surface_has_explicit_permission_and_text_limit() {
    let (f, _s, data) = fixture().await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    prepared(&f, agent).await;
    let base = f.path(&format!("/computer/bots/{agent}"));
    let (_, action) = f
        .request(
            "POST",
            &format!("{base}/actions"),
            Some(json!({"type":"browser_click","selector":"#run"})),
            false,
            Some(&f.owner),
        )
        .await;
    let (status, lease) = f
        .request(
            "POST",
            &format!("{base}/takeover/start"),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{lease}");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    assert_eq!(
        computer::action_store::get(&store, action["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "rejected"
    );
    assert_eq!(
        f.request(
            "POST",
            &format!("{base}/takeover/input"),
            Some(json!({"leaseId":lease["leaseId"],"type":"click","x":1,"y":1})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        409
    );
    assert_eq!(
        f.request(
            "POST",
            &format!("{base}/takeover/end"),
            Some(json!({"leaseId":lease["leaseId"]})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        f.request(
            "POST",
            &format!("{base}/surface"),
            Some(json!({"surface":"desktop"})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    let (status, desktop) = f
        .request(
            "POST",
            &format!("{base}/surface"),
            Some(json!({"surface":"desktop","confirm":true})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{desktop}");
    assert_eq!(desktop["surface"], "desktop");
    assert_eq!(desktop["botScreen"]["agentId"], agent);
    assert_eq!(desktop["botScreen"]["status"], "ready");
    assert_eq!(
        f.request(
            "POST",
            &format!("{base}/actions"),
            Some(json!({"type":"desktop_type","text":"甲".repeat(301)})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    f.state.close().await;
}
#[tokio::test]
async fn root_task_queue_keeps_same_bot_exclusive_until_cleanup_and_does_not_block_other_bot() {
    let (f, _s, data) = fixture().await;
    let first = data["agents"][0]["id"].as_str().unwrap();
    let second = data["agents"][1]["id"].as_str().unwrap();
    let actor = access::require(
        &f.state,
        &headers(&f.owner_token, &f.owner),
        &f.workspace,
        true,
        true,
    )
    .await
    .unwrap();
    let store = actor.store(&f.state).await.unwrap();
    let controller = f.state.computer.get(&f.state, store).await.unwrap();
    let authority = computer::controller::user_authority(&f.state, &actor);
    let a = computer::tasks::acquire(&controller, first, "chat-a", "run-a", authority.clone())
        .await
        .unwrap();
    let b = tokio::time::timeout(
        Duration::from_secs(10),
        computer::tasks::acquire(&controller, second, "chat-b", "run-b", authority.clone()),
    )
    .await
    .expect("the second Bot should acquire its own screen while the first Bot is active")
    .unwrap();
    let mut updates = controller.store.subscribe();
    let waiting = {
        let c = controller.clone();
        let agent = first.to_owned();
        tokio::spawn(async move {
            computer::tasks::acquire(&c, &agent, "chat-c", "run-c", authority).await
        })
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        while controller.tasks.state(first)["queued"] != 1 {
            updates
                .recv()
                .await
                .expect("the workspace should emit task updates");
        }
    })
    .await
    .expect("the same Bot's second task should enter the queue");
    assert_eq!(controller.tasks.state(first)["conversationId"], "chat-a");
    assert!(!waiting.is_finished());
    a.finish().await.unwrap();
    let c = tokio::time::timeout(Duration::from_secs(10), waiting)
        .await
        .expect("the queued task should acquire the screen after the first task finishes")
        .unwrap()
        .unwrap();
    assert_eq!(controller.tasks.state(first)["conversationId"], "chat-c");
    c.finish().await.unwrap();
    b.finish().await.unwrap();
    assert_eq!(controller.tasks.state(first)["status"], "idle");
    f.state.close().await;
}
