mod workspace_support;

use serde_json::{Value, json};
use workspace_support::Fixture;

async fn request(
    f: &Fixture,
    method: &str,
    path: &str,
    body: Option<Value>,
    member: bool,
) -> (u16, Value) {
    let user = if member { &f.member } else { &f.owner };
    f.request(method, &f.path(path), body, member, Some(user))
        .await
}

async fn draft(f: &Fixture, agent: &Value, content: &str) -> Value {
    let (status, value) = request(
        f, "POST", "/skills",
        Some(json!({"agentId":agent,"name":"Synthetic review","description":"Review evidence","content":content})),
        false,
    )
    .await;
    assert_eq!(status, 201, "{value}");
    value
}

async fn approve(f: &Fixture, skill: &Value, expected: Value) -> Value {
    let (status, value) = request(
        f,
        "POST",
        &format!("/skills/{}/approve", skill["id"].as_str().unwrap()),
        Some(json!({"expectedActiveId":expected})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "active");
    value
}

#[tokio::test]
async fn published_team_skill_revisions_are_explicit_and_imports_remain_pinned() {
    let f = Fixture::new().await;
    let source = f.bootstrap().await["agents"][0]["id"].clone();
    let (status, target) = request(
        &f, "POST", "/agents",
        Some(json!({"name":"Synthetic target","role":"Reviewer","description":"","instructions":"","avatar":"orb","color":"#76568d"})),
        false,
    )
    .await;
    assert_eq!(status, 201, "{target}");
    let first = draft(&f, &source, "Review from original source.").await;
    let publish = json!({"skillId":first["id"],"expectedRevision":null});
    assert_eq!(
        request(&f, "POST", "/team-skills", Some(publish.clone()), false)
            .await
            .0,
        409
    );
    approve(&f, &first, Value::Null).await;
    assert_eq!(
        request(&f, "POST", "/team-skills", Some(publish.clone()), true)
            .await
            .0,
        403
    );
    let (status, first_publication) =
        request(&f, "POST", "/team-skills", Some(publish.clone()), false).await;
    assert_eq!(status, 200, "{first_publication}");
    assert_eq!(first_publication["version"], 1);
    let (_, repeated) = request(&f, "POST", "/team-skills", Some(publish), false).await;
    assert_eq!(repeated, first_publication);
    let (status, items) = request(&f, "GET", "/team-skills", None, true).await;
    assert_eq!(status, 200);
    assert_eq!(first_publication["canWithdraw"], true);
    let mut member_item = first_publication.clone();
    member_item["canWithdraw"] = json!(false);
    assert_eq!(items, json!([member_item]));
    let id = first_publication["id"].as_str().unwrap();
    let import_path = format!("/team-skills/{id}/import");
    let import_first =
        json!({"agentId":target["id"],"expectedRevision":first_publication["revision"]});
    assert_eq!(
        request(&f, "POST", &import_path, Some(import_first.clone()), true)
            .await
            .0,
        403
    );
    let (status, imported) =
        request(&f, "POST", &import_path, Some(import_first.clone()), false).await;
    assert_eq!(status, 200, "{imported}");
    assert_eq!(imported["status"], "proposed");
    assert_eq!(imported["content"], first["content"]);
    assert_eq!(
        imported["teamSource"]["revision"],
        first_publication["revision"]
    );
    let (_, replayed_import) =
        request(&f, "POST", &import_path, Some(import_first.clone()), false).await;
    assert_eq!(imported, replayed_import);
    approve(&f, &imported, Value::Null).await;
    let (status, copy_source) = request(
        &f,
        "GET",
        &format!("/bot-copy-source/{}", target["id"].as_str().unwrap()),
        None,
        false,
    )
    .await;
    assert_eq!(status, 200, "{copy_source}");
    assert_eq!(copy_source["blueprint"]["skills"], json!([]));
    assert_eq!(
        request(
            &f,
            "POST",
            "/team-skills",
            Some(json!({"skillId":imported["id"],"expectedRevision":null})),
            false
        )
        .await
        .0,
        409
    );

    let second = draft(&f, &source, "Review from updated source.").await;
    approve(&f, &second, first["id"].clone()).await;
    let (_, still_first) = request(&f, "GET", "/team-skills", None, true).await;
    assert_eq!(still_first, json!([member_item]));
    assert_eq!(
        request(
            &f,
            "POST",
            "/team-skills",
            Some(json!({"skillId":second["id"],"expectedRevision":null})),
            false
        )
        .await
        .0,
        409
    );
    let (status, second_publication) = request(
        &f,
        "POST",
        "/team-skills",
        Some(json!({"skillId":second["id"],"expectedRevision":first_publication["revision"]})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{second_publication}");
    assert_eq!(second_publication["id"], id);
    assert_eq!(second_publication["version"], 2);
    assert_ne!(
        second_publication["revision"],
        first_publication["revision"]
    );
    let (status, import_second) = request(
        &f,
        "POST",
        &import_path,
        Some(json!({"agentId":target["id"],"expectedRevision":second_publication["revision"]})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{import_second}");
    assert_eq!(import_second["status"], "proposed");
    assert_eq!(import_second["content"], second["content"]);
    assert_eq!(import_second["teamSource"]["version"], 2);
    let removed_path = format!("/skills/{}", import_second["id"].as_str().unwrap());
    assert_eq!(
        request(&f, "DELETE", &removed_path, None, false).await.0,
        200
    );
    let (status, imported_again) = request(
        &f,
        "POST",
        &import_path,
        Some(json!({"agentId":target["id"],"expectedRevision":second_publication["revision"]})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{imported_again}");
    assert_ne!(imported_again["id"], import_second["id"]);
    assert_eq!(imported_again["status"], "proposed");
    assert_eq!(imported_again["teamSource"], import_second["teamSource"]);
    let (status, foreign) = f
        .request(
            "GET",
            &format!("/api/workspaces/{}/team-skills", f.foreign),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(foreign, json!([]));
    let revoke_path = format!("/team-skills/{id}/unpublish");
    assert_eq!(
        request(
            &f,
            "POST",
            &revoke_path,
            Some(json!({"expectedRevision":first_publication["revision"]})),
            false
        )
        .await
        .0,
        409
    );
    assert_eq!(
        request(
            &f,
            "POST",
            &revoke_path,
            Some(json!({"expectedRevision":second_publication["revision"]})),
            false
        )
        .await
        .0,
        200
    );
    let (_, withdrawn) = request(&f, "GET", "/team-skills", None, true).await;
    assert_eq!(withdrawn, json!([]));
    let skills = f.bootstrap().await["skills"].as_array().unwrap().clone();
    let original = skills
        .iter()
        .find(|skill| skill["id"] == imported["id"])
        .unwrap();
    assert_eq!(original["status"], "active");
    assert_eq!(original["content"], first["content"]);
    assert_eq!(
        original["teamSource"]["revision"],
        first_publication["revision"]
    );
    f.close().await;
}
