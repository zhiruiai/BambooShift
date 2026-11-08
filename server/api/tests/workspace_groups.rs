mod workspace_support;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use workspace_support::Fixture;

async fn setup() -> (Fixture, Value, Vec<Value>) {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let mut agents = vec![boot["agents"][0].clone()];
    let (status, agent) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(json!({"name":"Second"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201);
    agents.push(agent);
    let(status,chat)=f.request("POST",&f.path("/conversations"),Some(json!({"title":"Synthetic group","agentIds":[agents[0]["id"],agents[1]["id"]],"isGroup":true})),true,Some(&f.member)).await;
    assert_eq!(status, 201);
    (f, chat, agents)
}
#[tokio::test]
async fn group_settings_allow_members_but_require_complete_consistent_assignments() {
    let (f, chat, agents) = setup().await;
    let path = f.path(&format!(
        "/conversations/{}/settings",
        chat["id"].as_str().unwrap()
    ));
    let (status, current) = f.request("GET", &path, None, true, Some(&f.member)).await;
    assert_eq!(status, 200);
    let mut body = json!({"expectedRevision":current["revision"],"title":"Confirmed work","agentIds":chat["agentIds"],"teamBrief":{"goal":"Synthetic goal","summary":"Coordinate the work","leadAgentId":agents[0]["id"],"assignments":[{"agentId":agents[0]["id"],"assignment":"Lead"},{"agentId":agents[1]["id"],"assignment":"Review"}]}});
    let (status, saved) = f
        .request("PATCH", &path, Some(body.clone()), true, Some(&f.member))
        .await;
    assert_eq!(status, 200, "{saved}");
    body["expectedRevision"] = saved["revision"].clone();
    body["teamBrief"]["assignments"] =
        json!([{ "agentId":agents[0]["id"],"assignment":"Incomplete"}]);
    let (status, _) = f
        .request("PATCH", &path, Some(body.clone()), true, Some(&f.member))
        .await;
    assert_eq!(status, 400);
    body.as_object_mut().unwrap().remove("teamBrief");
    let (status, _) = f
        .request("PATCH", &path, Some(body), true, Some(&f.member))
        .await;
    assert_eq!(status, 400);
    let (_, after) = f.request("GET", &path, None, true, Some(&f.member)).await;
    assert_eq!(after, saved);
    f.close().await;
}
#[tokio::test]
async fn group_cas_ignores_activity_and_concurrent_changes_have_one_winner() {
    let (f, chat, _) = setup().await;
    let path = f.path(&format!(
        "/conversations/{}/settings",
        chat["id"].as_str().unwrap()
    ));
    let (_, current) = f.request("GET", &path, None, true, Some(&f.member)).await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut active = chat.clone();
    active["unread"] = json!(10);
    active["updatedAt"] = json!("2030-01-01T00:00:00.000Z");
    store.put(Table::Conversations, &active).await.unwrap();
    let left =
        json!({"expectedRevision":current["revision"],"title":"Left","agentIds":chat["agentIds"]});
    let right =
        json!({"expectedRevision":current["revision"],"title":"Right","agentIds":chat["agentIds"]});
    let (a, b) = tokio::join!(
        f.request("PATCH", &path, Some(left), false, Some(&f.owner)),
        f.request("PATCH", &path, Some(right), true, Some(&f.member))
    );
    let mut statuses = vec![a.0, b.0];
    statuses.sort();
    assert_eq!(statuses, vec![200, 409]);
    let (_, latest) = f.request("GET", &path, None, false, Some(&f.owner)).await;
    assert!([json!("Left"), json!("Right")].contains(&latest["conversation"]["title"]));
    assert_eq!(latest["conversation"]["unread"], 0);
    assert_eq!(latest["conversation"]["readThrough"], 0);
    f.close().await;
}
#[tokio::test]
async fn imported_shared_primary_dm_and_bot_definition_cannot_be_overwritten() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut bot = boot["agents"][0].clone();
    let chat = boot["conversations"][0].clone();
    let stored_chat = store
        .get(Table::Conversations, chat["id"].as_str().unwrap())
        .await
        .unwrap();
    bot["sharedBot"] =
        json!({"shareId":uuid::Uuid::new_v4().to_string(),"conversationId":chat["id"]});
    store.put(Table::Agents, &bot).await.unwrap();
    for (method, path, body) in [
        (
            "PATCH",
            f.path(&format!("/agents/{}", bot["id"].as_str().unwrap())),
            Some(json!({"name":"Hijack"})),
        ),
        (
            "PATCH",
            f.path(&format!("/conversations/{}", chat["id"].as_str().unwrap())),
            Some(json!({"title":"Hijack"})),
        ),
        (
            "DELETE",
            f.path(&format!("/conversations/{}", chat["id"].as_str().unwrap())),
            None,
        ),
    ] {
        let (status, _) = f.request(method, &path, body, false, Some(&f.owner)).await;
        assert_eq!(status, 403);
    }
    assert_eq!(
        store
            .get(Table::Agents, bot["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["name"],
        bot["name"]
    );
    assert_eq!(
        store
            .get(Table::Conversations, chat["id"].as_str().unwrap())
            .await
            .unwrap(),
        stored_chat
    );
    f.close().await;
}
