mod workspace_support;

use openbot_backend::{config::Config, db::State, workspace::Table};
use serde_json::{Value, json};
use workspace_support::Fixture;

fn foundation(boot: &Value, agent: &Value) -> Vec<Value> {
    boot["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|skill| skill["agentId"] == agent["id"])
        .cloned()
        .collect()
}

#[tokio::test]
async fn every_local_bot_gets_real_packages_without_granting_computer_access() {
    let f = Fixture::new().await;
    let first = f.bootstrap().await;
    let initial = foundation(&first, &first["agents"][0]);
    assert_eq!(initial.len(), 4);
    let (status, bot) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(json!({
                "name":"Research helper","role":"Research","description":"Review public evidence",
                "instructions":"Use public sources","avatar":"orb","color":"#8b5cf6"
            })),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{bot}");
    let boot = f.bootstrap().await;
    let skills = foundation(&boot, &bot);
    assert_eq!(skills.len(), 4);
    for name in [
        "web-research",
        "browser-use",
        "computer-use",
        "agent-desktop",
    ] {
        let skill = skills.iter().find(|skill| skill["name"] == name).unwrap();
        assert_eq!(skill["status"], "active");
        assert_eq!(skill["skillPackage"]["format"], "agent-skills");
        assert!(skill["skillPackage"]["files"].as_array().unwrap().len() >= 3);
    }
    assert_eq!(boot["settings"], first["settings"]);
    let (status, authorization) = f
        .request(
            "GET",
            &f.path("/computer/authorization"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{authorization}");
    assert_eq!(authorization["mode"], "confirm");
    f.close().await;
}

#[tokio::test]
async fn restart_preserves_removed_and_disabled_foundation_skills() {
    let mut f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let skills = foundation(&boot, &boot["agents"][0]);
    let removed = skills.iter().find(|s| s["name"] == "browser-use").unwrap();
    let disabled = skills.iter().find(|s| s["name"] == "computer-use").unwrap();
    let (status, body) = f
        .request(
            "DELETE",
            &f.path(&format!("/skills/{}", removed["id"].as_str().unwrap())),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = f
        .request(
            "POST",
            &f.path(&format!(
                "/skills/{}/disable",
                disabled["id"].as_str().unwrap()
            )),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let expected = f.bootstrap().await["skills"].clone();
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    assert_eq!(f.bootstrap().await["skills"], expected);
    f.close().await;
}

#[tokio::test]
async fn migration_preserves_authored_lineages_and_skips_shared_bots() {
    let mut f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let agent = &boot["agents"][0];
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut tx = store.pool.begin().await.unwrap();
    for skill in foundation(&boot, agent) {
        openbot_backend::workspace::WorkspaceStore::delete_in(
            &mut tx,
            Table::Skills,
            skill["id"].as_str().unwrap(),
        )
        .await
        .unwrap();
    }
    openbot_backend::workspace::WorkspaceStore::delete_in(
        &mut tx,
        Table::Settings,
        &format!("foundation-skills:{}", agent["id"].as_str().unwrap()),
    )
    .await
    .unwrap();
    let custom = json!({"id":uuid::Uuid::new_v4().to_string(),"agentId":agent["id"],"name":"web-research","description":"Custom policy","content":"Use approved sources only","status":"disabled","version":1});
    openbot_backend::workspace::WorkspaceStore::put_in(&mut tx, Table::Skills, &custom)
        .await
        .unwrap();
    let mut shared = agent.clone();
    shared["id"] = json!(uuid::Uuid::new_v4().to_string());
    shared["sharedBot"] =
        json!({"sourceWorkspaceId":f.foreign,"sourceAgentId":uuid::Uuid::new_v4().to_string()});
    openbot_backend::workspace::WorkspaceStore::put_in(&mut tx, Table::Agents, &shared)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let skills = store.list(Table::Skills).await.unwrap();
    assert_eq!(skills.len(), 4);
    assert!(skills.iter().all(|s| s["agentId"] != shared["id"]));
    let preserved = skills.iter().find(|s| s["id"] == custom["id"]).unwrap();
    assert_eq!(preserved["content"], custom["content"]);
    assert_eq!(preserved["status"], "disabled");
    f.close().await;
}
