mod agent_delegation_support;
mod agent_primary_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, finish};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::Arc;

async fn request(group: &Group, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    group
        .f
        .request(
            method,
            &group.f.path(path),
            body,
            false,
            Some(&group.f.owner),
        )
        .await
}

async fn draft(group: &Group, bot: &str, name: &str, content: &str) -> Value {
    let (status, value) = request(
        group, "POST", "/skills", Some(json!({
            "agentId":bot,"name":name,"description":"Synthetic skill for this test","content":content
        })),
    ).await;
    assert_eq!(status, 201, "{value}");
    value
}

async fn approve(group: &Group, skill: &Value, previous: Option<&Value>) -> Value {
    let (status, value) = request(
        group,
        "POST",
        &format!("/skills/{}/approve", skill["id"].as_str().unwrap()),
        Some(json!({"expectedActiveId":previous.map(|old| &old["id"])})),
    )
    .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "active");
    value
}

async fn shelf(group: &Group) -> Value {
    let (status, value) = request(group, "GET", "/private-skills", None).await;
    assert_eq!(status, 200, "{value}");
    value
}

fn shelf_entry<'a>(shelf: &'a Value, source: &Value) -> Option<&'a Value> {
    shelf["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == source["id"])
}

fn toggle_path(item: &Value, target: &str) -> String {
    format!(
        "/private-skills/{}/bots/{target}",
        item["id"].as_str().unwrap()
    )
}

fn toggle_body(item: &Value, enabled: bool) -> Value {
    json!({"enabled":enabled,"expectedRevision":item["revision"]})
}

async fn toggle(group: &Group, item: &Value, target: &str, enabled: bool) -> (u16, Value) {
    request(
        group,
        "PUT",
        &toggle_path(item, target),
        Some(toggle_body(item, enabled)),
    )
    .await
}

async fn set_enabled(group: &Group, item: &Value, target: &str, enabled: bool) {
    let (status, value) = toggle(group, item, target, enabled).await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value, json!({"enabled":enabled}));
}

async fn active(group: &Group, bot: &str, name: &str) -> Vec<Value> {
    group
        .store
        .list(Table::Skills)
        .await
        .unwrap()
        .into_iter()
        .filter(|skill| {
            skill["agentId"] == bot && skill["name"] == name && skill["status"] == "active"
        })
        .collect()
}

#[tokio::test]
async fn only_personal_owner_can_pin_a_reviewed_local_skill_and_remove_the_exact_pin() {
    let group = Group::new().await;
    let group_chat = group.cid.clone();
    assert_eq!(request(&group, "GET", "/private-skills", None).await.0, 403);
    let group = agent_primary_support::personal(group).await;
    let target = &group.ids[0];
    let source = &group.ids[1];
    let conflict_bot = &group.ids[2];
    let spare = &group.ids[3];
    let name = "Evidence checklist";
    let proposed = draft(&group, source, name, "Verify the original source.").await;
    assert!(shelf_entry(&shelf(&group).await, &proposed).is_none());
    let first = approve(&group, &proposed, None).await;
    let source_state = shelf(&group).await;
    let first_item = shelf_entry(&source_state, &first).unwrap();
    assert_eq!(first_item["sourceAgentId"], *source);
    assert_eq!(first_item["sourceAgentName"], "Synthetic colleague 1");
    assert_eq!(first_item["name"], name);
    assert_eq!(first_item["version"], 1);
    assert_eq!(first_item["content"], first["content"]);
    assert_eq!(first_item["available"], true);
    assert_eq!(first_item["enabledAgentIds"], json!([]));

    let personal_path = group.f.path("/private-skills");
    for (member, expected_user) in [(true, Some(group.f.member.as_str())), (false, None)] {
        assert_eq!(
            group
                .f
                .request("GET", &personal_path, None, member, expected_user)
                .await
                .0,
            403
        );
        assert_eq!(
            group
                .f
                .request(
                    "PUT",
                    &group.f.path(&toggle_path(first_item, target)),
                    Some(toggle_body(first_item, true)),
                    member,
                    expected_user,
                )
                .await
                .0,
            403
        );
    }
    for invalid_target in [&group_chat, &uuid::Uuid::new_v4().to_string()] {
        assert_eq!(
            toggle(&group, first_item, invalid_target, true).await.0,
            409
        );
    }

    let member_boot = format!("/api/workspaces/{}/bootstrap", group.f.foreign);
    let (status, foreign) = group
        .f
        .request("GET", &member_boot, None, true, Some(&group.f.member))
        .await;
    assert_eq!(status, 200, "{foreign}");
    let foreign_bot = foreign["agents"][0]["id"].as_str().unwrap();
    assert_eq!(toggle(&group, first_item, foreign_bot, true).await.0, 409);

    let local = approve(
        &group,
        &draft(&group, conflict_bot, name, "Unrelated same-name skill.").await,
        None,
    )
    .await;
    assert_eq!(toggle(&group, first_item, conflict_bot, true).await.0, 409);
    set_enabled(&group, first_item, conflict_bot, false).await;
    assert_eq!(
        active(&group, conflict_bot, name).await[0]["id"],
        local["id"]
    );

    set_enabled(&group, first_item, target, true).await;
    set_enabled(&group, first_item, target, true).await;
    let installed = active(&group, target, name).await;
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0]["content"], first["content"]);
    assert_ne!(installed[0]["id"], first["id"]);
    set_enabled(&group, first_item, target, false).await;
    set_enabled(&group, first_item, target, true).await;
    assert_eq!(
        active(&group, target, name).await[0]["id"],
        installed[0]["id"]
    );
    let (status, portable) =
        request(&group, "GET", &format!("/bot-copy-source/{target}"), None).await;
    assert_eq!(status, 200, "{portable}");
    assert_eq!(portable["blueprint"]["skills"], json!([]));
    let pinned = shelf(&group).await;
    assert!(shelf_entry(&pinned, &installed[0]).is_none());
    assert_eq!(
        shelf_entry(&pinned, &first).unwrap()["enabledAgentIds"],
        json!([target])
    );

    let mut imported = approve(
        &group,
        &draft(&group, spare, "Team import", "Never on the private shelf.").await,
        None,
    )
    .await;
    // Seed a provenance marker without requiring a second team publication flow.
    imported["teamSource"] = json!({"workspaceId":group.f.foreign,"publicationId":uuid::Uuid::new_v4().to_string(),"revision":uuid::Uuid::new_v4().to_string()});
    group.store.put(Table::Skills, &imported).await.unwrap();
    assert!(shelf_entry(&shelf(&group).await, &imported).is_none());

    let second_draft = draft(&group, source, name, "Use the revised checklist.").await;
    let second = approve(&group, &second_draft, Some(&first)).await;
    let updated = shelf(&group).await;
    let retired = shelf_entry(&updated, &first).unwrap();
    let fresh = shelf_entry(&updated, &second).unwrap();
    assert_eq!(retired["available"], false);
    assert_eq!(retired["enabledAgentIds"], json!([target]));
    assert_eq!(fresh["available"], true);
    assert_eq!(fresh["version"], 2);
    assert_ne!(retired["revision"], fresh["revision"]);
    assert_eq!(
        active(&group, target, name).await[0]["content"],
        first["content"]
    );
    assert_eq!(toggle(&group, retired, spare, true).await.0, 409);
    assert_eq!(toggle(&group, fresh, target, true).await.0, 409);
    let stale_disable = json!({"enabled":false,"expectedRevision":fresh["revision"]});
    assert_eq!(
        request(
            &group,
            "PUT",
            &toggle_path(retired, target),
            Some(stale_disable)
        )
        .await
        .0,
        409
    );

    let shared_skill = approve(
        &group,
        &draft(
            &group,
            spare,
            "Shared source",
            "Never offered as a local source.",
        )
        .await,
        None,
    )
    .await;
    // A shared alias can never be selected as either side of the private shelf.
    let mut shared_agent = group
        .store
        .get(Table::Agents, spare)
        .await
        .unwrap()
        .unwrap();
    shared_agent["sharedBot"] = json!({"shareId":uuid::Uuid::new_v4().to_string()});
    group.store.put(Table::Agents, &shared_agent).await.unwrap();
    let listing = shelf(&group).await;
    assert!(
        listing["agents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|agent| agent["id"] != *spare)
    );
    assert!(shelf_entry(&listing, &shared_skill).is_none());
    assert_eq!(toggle(&group, fresh, spare, true).await.0, 409);

    let (status, deleted) = request(&group, "DELETE", &format!("/agents/{source}"), None).await;
    assert_eq!(status, 200, "{deleted}");
    let listing = shelf(&group).await;
    let orphan = shelf_entry(&listing, &first).unwrap();
    assert_eq!(orphan["content"], first["content"]);
    assert_eq!(orphan["available"], false);
    assert_eq!(orphan["enabledAgentIds"], json!([target]));
    assert!(shelf_entry(&listing, &second).is_none());
    set_enabled(&group, orphan, target, false).await;
    set_enabled(&group, orphan, target, false).await;
    assert!(active(&group, target, name).await.is_empty());
    assert_eq!(
        active(&group, conflict_bot, name).await[0]["id"],
        local["id"]
    );
    assert!(shelf_entry(&shelf(&group).await, &first).is_none());
    group.close().await;
}

#[tokio::test]
async fn pi_reads_only_the_approved_version_explicitly_enabled_for_its_bot() {
    let group = agent_primary_support::personal(Group::new().await).await;
    let source = &group.ids[1];
    let target = &group.ids[0];
    let marker = "PRIVATE_SHELF_FIRST_APPROVED_FIXTURE";
    let first = approve(
        &group,
        &draft(&group, source, "Evidence pass", marker).await,
        None,
    )
    .await;
    let model = Model::new(Arc::new(|_| {
        Box::pin(async { finish("Checked the current approved skills.") })
    }))
    .await;
    group.configure(&model).await;

    group
        .send("Check my current skills.", "followUp", false)
        .await;
    group.done().await;
    assert!(!agent_primary_support::system(&model.calls.lock().await[0]).contains(marker));

    let listing = shelf(&group).await;
    let first_item = shelf_entry(&listing, &first).unwrap();
    set_enabled(&group, first_item, target, true).await;
    let newer = "PRIVATE_SHELF_NEWER_APPROVED_FIXTURE";
    let second = draft(&group, source, "Evidence pass", newer).await;
    approve(&group, &second, Some(&first)).await;
    group
        .send("Check my current skills.", "followUp", false)
        .await;
    group.done().await;
    let system = agent_primary_support::system(&model.calls.lock().await[1]);
    assert!(system.contains(marker));
    assert!(!system.contains(newer));

    let listing = shelf(&group).await;
    set_enabled(
        &group,
        shelf_entry(&listing, &first).unwrap(),
        target,
        false,
    )
    .await;
    group
        .send("Check my current skills.", "followUp", false)
        .await;
    group.done().await;
    let records = model.calls.lock().await;
    assert_eq!(records.len(), 3);
    let system = agent_primary_support::system(&records[2]);
    assert!(!system.contains(marker));
    assert!(!system.contains(newer));
    drop(records);
    group.close().await;
}
