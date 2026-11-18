use super::*;
use openbot_backend::workspace::Table;

#[tokio::test]
async fn attach_only_the_requesters_transferred_chat_image_to_the_same_bot_and_computer() {
    let (f, worker, data) = fixture().await;
    let bots = data["agents"].as_array().unwrap();
    let agent = bots[0]["id"].as_str().unwrap();
    let other = bots[1]["id"].as_str().unwrap();
    let chats = data["conversations"].as_array().unwrap();
    let chat = chats
        .iter()
        .find(|c| c["agentIds"].as_array().unwrap().iter().any(|a| a == agent))
        .unwrap()["id"]
        .clone();
    let other_chat = chats.iter().find(|c| c["id"] != chat).unwrap()["id"].clone();
    prepared(&f, agent).await;
    let endpoint = f.path(&format!("/computer/bots/{agent}/actions"));
    let (status, file) = f.request("POST", &f.path("/files"), Some(json!({
        "name":"cover.png","type":"image/png","conversationId":chat,
        "content":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII="
    })), false, Some(&f.owner)).await;
    assert_eq!(status, 201, "{file}");
    let (status, upload) = f
        .request(
            "POST",
            &endpoint,
            Some(json!({
                "type":"upload_file","fileId":file["id"],"path":"cover.png","conversationId":chat,
            })),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{upload}");
    let upload_id = upload["id"].as_str().unwrap();
    let attach = json!({"type":"browser_attach_image","uploadActionId":upload_id,
        "tabId":uuid::Uuid::new_v4().to_string(),"url":"https://creator.example","selector":"#cover","conversationId":chat});
    assert_eq!(
        f.request(
            "POST",
            &endpoint,
            Some(attach.clone()),
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
            &format!("{endpoint}/{upload_id}/approve"),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    let done = settled(&f, upload_id).await;
    assert_eq!(done["status"], "done", "{done}");
    for key in ["path", "sha256", "fileId"] {
        let mut forged = attach.clone();
        forged[key] = json!("different");
        assert_eq!(
            f.request("POST", &endpoint, Some(forged), false, Some(&f.owner))
                .await
                .0,
            400
        );
    }
    let mut different_chat = attach.clone();
    different_chat["conversationId"] = other_chat;
    assert_eq!(
        f.request(
            "POST",
            &endpoint,
            Some(different_chat),
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
            &endpoint,
            Some(attach.clone()),
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
            &f.path(&format!("/computer/bots/{other}/actions")),
            Some(attach.clone()),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    let (status, approved) = f
        .request(
            "POST",
            &endpoint,
            Some(attach.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{approved}");
    let id = approved["id"].as_str().unwrap();
    assert_eq!(approved["payload"]["path"], done["result"]["path"]);
    assert_eq!(approved["payload"]["sha256"], done["result"]["sha256"]);
    assert_eq!(
        f.request(
            "POST",
            &format!("{endpoint}/{id}/approve"),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    let attached = settled(&f, id).await;
    assert_eq!(attached["status"], "done", "{attached}");
    assert_eq!(attached["result"]["attached"], true);

    for selector in ["#upload-interrupted", "#gateway-lost-reply"] {
        let mut interrupted = attach.clone();
        interrupted["selector"] = json!(selector);
        let (status, request) = f
            .request("POST", &endpoint, Some(interrupted), false, Some(&f.owner))
            .await;
        assert_eq!(status, 200, "{request}");
        let id = request["id"].as_str().unwrap();
        let (status, response) = f
            .request(
                "POST",
                &format!("{endpoint}/{id}/approve"),
                Some(json!({})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 200, "{response}");
        let result = settled(&f, id).await;
        assert_eq!(result["status"], "error", "{result}");
        assert!(
            result["error"].as_str().unwrap().contains("避免重复上传"),
            "{result}"
        );
    }

    // Removing the user's file-message provenance while approval is pending invalidates it.
    let (_, pending) = f
        .request(
            "POST",
            &endpoint,
            Some(attach.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    let pending_id = pending["id"].as_str().unwrap();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let message = store
        .list(Table::Messages)
        .await
        .unwrap()
        .into_iter()
        .find(|m| m["metadata"]["fileId"] == file["id"])
        .unwrap();
    sqlx::query("DELETE FROM messages WHERE id=?")
        .bind(message["id"].as_str().unwrap())
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.request(
            "POST",
            &format!("{endpoint}/{pending_id}/approve"),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    assert_eq!(settled(&f, pending_id).await["status"], "error");
    assert_eq!(
        worker
            .worker
            .calls
            .lock()
            .await
            .iter()
            .filter(|(_, b)| b["type"] == "browser_attach_image")
            .count(),
        3
    );
    f.state.close().await;
}
