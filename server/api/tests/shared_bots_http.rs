mod shared_bots_support;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use shared_bots_support::*;

#[tokio::test]
async fn source_owner_controls_team_scope_and_directory_get_never_initializes_personal_storage() {
    let mut s = Shared::new().await;
    let personal_db = s.f.directory.path().join("spaces").join(&s.personal);
    assert!(!personal_db.exists());
    let path = format!("/api/shared-bots?personalWorkspaceId={}", s.personal);
    let (status, items) =
        s.f.request("GET", &path, None, true, Some(&s.f.member))
            .await;
    assert_eq!(status, 200, "{items}");
    assert_eq!(items.as_array().unwrap().len(), 1);
    assert!(items[0].get("joined").is_none());
    assert!(!personal_db.exists());
    assert!(items[0].get("instructions").is_none());
    for (member, expected) in [(true, None), (true, Some(s.f.owner.as_str()))] {
        assert_eq!(
            s.f.request("GET", &path, None, member, expected).await.0,
            403
        );
    }
    assert_eq!(
        s.f.request("GET", &s.sharing(), None, true, Some(&s.f.member))
            .await
            .0,
        403
    );
    let invalid = json!({"requestId":id(),"expectedRevision":s.share["revision"],"targetTeamId":s.f.workspace,"audience":["selected"],"memberIds":[]});
    let (code, error) =
        s.f.request("PUT", &s.sharing(), Some(invalid), false, Some(&s.f.owner))
            .await;
    assert_eq!(code, 400);
    assert_eq!(error["code"], "SHARED_BOT_NOT_APPLIED");
    s.update(json!({"audience":"selected","memberIds":[s.f.owner]}))
        .await;
    assert_eq!(
        s.f.request("GET", "/api/shared-bots", None, true, Some(&s.f.member))
            .await
            .1,
        json!([])
    );
    let owner_items =
        s.f.request("GET", "/api/shared-bots", None, false, Some(&s.f.owner))
            .await
            .1;
    assert_eq!(
        owner_items.as_array().unwrap().len(),
        1,
        "creator retains eligibility"
    );
    s.close().await;
}
#[tokio::test]
async fn add_is_atomic_idempotent_private_and_read_receipt_survives_revoke() {
    let s = Shared::new().await;
    let request = id();
    let body = json!({"requestId":request,"shareId":s.share["id"]});
    let reference_path = s.ref_path();
    let ((a_status, a), (b_status, b)) = tokio::join!(
        s.f.request(
            "POST",
            &reference_path,
            Some(body.clone()),
            true,
            Some(&s.f.member)
        ),
        s.f.request(
            "POST",
            &reference_path,
            Some(body.clone()),
            true,
            Some(&s.f.member)
        )
    );
    assert_eq!((a_status, b_status), (201, 201), "{a} {b}");
    assert_eq!(a, b);
    let next = s.add().await;
    assert_eq!(a["agentId"], next["agentId"]);
    assert_eq!(a["conversationId"], next["conversationId"]);
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    assert_eq!(
        target
            .list(Table::Agents)
            .await
            .unwrap()
            .iter()
            .filter(|a| a.get("sharedBot").is_some())
            .count(),
        1
    );
    let raw = target
        .get(Table::Agents, a["agentId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(raw["avatarImageId"], Value::Null);
    assert_ne!(raw["id"], s.agent);
    assert!(target.list(Table::Memories).await.unwrap().is_empty());
    assert!(target.list(Table::Skills).await.unwrap().is_empty());
    let bootstrap = format!("/api/workspaces/{}/bootstrap", s.personal);
    assert_eq!(
        s.f.request("GET", &bootstrap, None, false, Some(&s.f.owner))
            .await
            .0,
        403,
        "source owner cannot see recipient private chat"
    );
    let message = json!({"id":id(),"role":"user","conversationId":a["conversationId"],"content":"PRIVATE_RECIPIENT_TEXT"});
    target.put(Table::Messages, &message).await.unwrap();
    assert!(
        !s.f.bootstrap()
            .await
            .to_string()
            .contains("PRIVATE_RECIPIENT_TEXT")
    );
    let (status, _) =
        s.f.request(
            "POST",
            &format!("{}/revoke", s.sharing()),
            Some(json!({"requestId":id(),"expectedRevision":s.share["revision"]})),
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(status, 200);
    let replay =
        s.f.request("POST", &s.ref_path(), Some(body), true, Some(&s.f.member))
            .await;
    assert_eq!(replay.0, 201);
    assert_eq!(replay.1, a);
    let recovered =
        s.f.request(
            "GET",
            &format!("{}/{request}", s.ref_path()),
            None,
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(recovered, (200, a.clone()));
    let (_, state) =
        s.f.request("GET", &bootstrap, None, true, Some(&s.f.member))
            .await;
    assert!(
        state["messages"]
            .to_string()
            .contains("PRIVATE_RECIPIENT_TEXT")
    );
    assert_eq!(
        state["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == a["agentId"])
            .unwrap()["sharedBot"]["status"],
        "unavailable"
    );
    s.close().await;
}
#[tokio::test]
async fn shared_profile_and_main_dm_are_managed_and_cannot_be_forked_or_reshared() {
    let s = Shared::new().await;
    let receipt = s.add().await;
    let prefix = format!("/api/workspaces/{}", s.personal);
    let agent = receipt["agentId"].as_str().unwrap();
    let chat = receipt["conversationId"].as_str().unwrap();
    for (method, path, body) in [
        (
            "PATCH",
            format!("{prefix}/agents/{agent}"),
            Some(json!({"name":"Override"})),
        ),
        ("DELETE", format!("{prefix}/agents/{agent}"), None),
        (
            "PATCH",
            format!("{prefix}/conversations/{chat}"),
            Some(json!({"isGroup":true})),
        ),
        ("DELETE", format!("{prefix}/conversations/{chat}"), None),
        ("GET", format!("{prefix}/agents/{agent}/sharing"), None),
    ] {
        let (status, body) =
            s.f.request(method, &path, body, true, Some(&s.f.member))
                .await;
        assert!(
            [400, 403, 409].contains(&status),
            "{method} {path} {status} {body}"
        );
    }
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    assert!(
        target
            .get(Table::Conversations, chat)
            .await
            .unwrap()
            .is_some()
    );
    let (_, state) =
        s.f.request(
            "GET",
            &format!("{prefix}/bootstrap"),
            None,
            true,
            Some(&s.f.member),
        )
        .await;
    assert!(
        state["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == agent && a["sharedBot"]["status"] == "active")
    );
    s.close().await;
}
#[tokio::test]
async fn account_header_and_target_workspace_cannot_be_switched_during_join_or_bootstrap() {
    let s = Shared::new().await;
    let body = json!({"requestId":id(),"shareId":s.share["id"]});
    assert_eq!(
        s.f.request(
            "POST",
            &s.ref_path(),
            Some(body.clone()),
            true,
            Some(&s.f.owner)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        s.f.request(
            "POST",
            &s.ref_path(),
            Some(body.clone()),
            false,
            Some(&s.f.owner)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        s.f.request(
            "POST",
            &s.f.path("/shared-bot-references"),
            Some(body),
            false,
            Some(&s.f.owner)
        )
        .await
        .0,
        403
    );
    s.add().await;
    let path = format!("/api/workspaces/{}/bootstrap", s.personal);
    assert_eq!(
        s.f.request("GET", &path, None, true, Some(&s.f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        s.f.request("GET", &path, None, true, Some(&s.f.member))
            .await
            .0,
        200
    );
    s.close().await;
}
