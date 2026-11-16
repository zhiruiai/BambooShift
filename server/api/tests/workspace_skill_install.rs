mod workspace_support;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use workspace_support::Fixture;

fn package(agent: &Value, script: &str) -> Value {
    json!({
        "agentId": agent, "name":"csv-review", "description":"Check CSV data",
        "content":"Read references/checklist.md, then run scripts/profile.py.",
        "expectedActiveId":null,
        "skillPackage":{
            "root":"csv-review", "frontmatter":{"license":"MIT"},
            "files":[
                {"path":"scripts/profile.py", "base64":STANDARD.encode(script)},
                {"path":"references/checklist.md", "base64":STANDARD.encode("Check the output.")}
            ]
        }
    })
}

async fn install(f: &Fixture, body: &Value) -> (u16, Value) {
    f.request(
        "POST",
        &f.path("/skills/install"),
        Some(body.clone()),
        false,
        Some(&f.owner),
    )
    .await
}

#[tokio::test]
async fn install_is_atomic_and_simultaneous_retry_reuses_the_exact_package() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let body = package(&boot["agents"][0]["id"], "print('first')\n");
    let (first, retry) = tokio::join!(install(&f, &body), install(&f, &body));
    assert!(matches!((first.0, retry.0), (201, 200) | (200, 201)));
    assert_eq!(first.1["id"], retry.1["id"]);
    assert_eq!(first.1["status"], "active");
    assert!(first.1["approvedAt"].is_string());
    let boot = f.bootstrap().await;
    let matching: Vec<_> = boot["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["name"] == "csv-review")
        .collect();
    assert_eq!(matching.len(), 1);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut conn = store.begin().await.unwrap();
    let files: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT path,content FROM skill_package_files WHERE skill_id=? ORDER BY path",
    )
    .bind(first.1["id"].as_str().unwrap())
    .fetch_all(&mut *conn)
    .await
    .unwrap();
    assert_eq!(files.len(), 3);
    assert_eq!(files[0].0, "SKILL.md");
    assert!(String::from_utf8_lossy(&files[0].1).contains("name: \"csv-review\""));
    assert_eq!(files[2].1, b"print('first')\n");
    conn.commit().await.unwrap();
    f.close().await;
}

#[tokio::test]
async fn upgrade_checks_current_version_and_does_not_replace_it_on_failure() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let body = package(&boot["agents"][0]["id"], "print('first')\n");
    let (status, first) = install(&f, &body).await;
    assert_eq!(status, 201);
    let mut update = package(&body["agentId"], "print('second')\n");
    let (status, conflict) = install(&f, &update).await;
    assert_eq!(status, 409);
    assert_eq!(conflict["code"], "SKILL_INSTALL_CHANGED");
    update["expectedActiveId"] = first["id"].clone();
    let mut invalid = update.clone();
    invalid["skillPackage"]["files"][0]["path"] = json!("../outside.py");
    assert_eq!(install(&f, &invalid).await.0, 400);
    let unchanged = f.bootstrap().await;
    let current = unchanged["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["name"] == "csv-review")
        .collect::<Vec<_>>();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0]["id"], first["id"]);
    assert_eq!(current[0]["status"], "active");
    let (status, second) = install(&f, &update).await;
    assert_eq!(status, 201);
    assert_eq!(second["version"], 2);
    assert_ne!(
        first["skillPackage"]["files"],
        second["skillPackage"]["files"]
    );
    assert_eq!(install(&f, &update).await.1["id"], second["id"]);
    assert_eq!(
        install(&f, &body).await.0,
        409,
        "An old retry cannot roll back a newer install"
    );
    let after = f.bootstrap().await;
    let previous = after["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == first["id"])
        .unwrap();
    assert_eq!(previous["status"], "archived");
    f.close().await;
}

#[tokio::test]
async fn existing_exact_draft_is_enabled_without_leaving_a_duplicate() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let body = package(&boot["agents"][0]["id"], "print('draft')\n");
    let mut draft_body = body.clone();
    draft_body
        .as_object_mut()
        .unwrap()
        .remove("expectedActiveId");
    let (status, draft) = f
        .request(
            "POST",
            &f.path("/skills"),
            Some(draft_body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201);
    assert_eq!(draft["status"], "proposed");
    let (status, active) = install(&f, &body).await;
    assert_eq!(status, 200);
    assert_eq!(active["id"], draft["id"]);
    assert_eq!(active["status"], "active");
    assert_eq!(active["version"], 1);
    f.close().await;
}

#[tokio::test]
async fn install_requires_owner_exact_account_and_current_local_bot() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let body = package(&boot["agents"][0]["id"], "print('no execution')\n");
    for (member, expected) in [
        (true, Some(f.member.as_str())),
        (false, None),
        (false, Some(f.member.as_str())),
    ] {
        assert_eq!(
            f.request(
                "POST",
                &f.path("/skills/install"),
                Some(body.clone()),
                member,
                expected
            )
            .await
            .0,
            403
        );
    }
    let mut missing_version = body.clone();
    missing_version
        .as_object_mut()
        .unwrap()
        .remove("expectedActiveId");
    assert_eq!(install(&f, &missing_version).await.0, 400);
    let mut missing_package = body.clone();
    missing_package
        .as_object_mut()
        .unwrap()
        .remove("skillPackage");
    assert_eq!(install(&f, &missing_package).await.0, 400);
    let mut unknown_agent = body.clone();
    unknown_agent["agentId"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(install(&f, &unknown_agent).await.0, 404);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut shared = boot["agents"][0].clone();
    shared["sharedBot"] = json!({"id":uuid::Uuid::new_v4().to_string()});
    let mut conn = store.begin().await.unwrap();
    openbot_backend::workspace::WorkspaceStore::put_in(
        &mut conn,
        openbot_backend::workspace::Table::Agents,
        &shared,
    )
    .await
    .unwrap();
    conn.commit().await.unwrap();
    assert_eq!(install(&f, &body).await.0, 403);
    assert_eq!(f.bootstrap().await["skills"], boot["skills"]);
    f.close().await;
}
