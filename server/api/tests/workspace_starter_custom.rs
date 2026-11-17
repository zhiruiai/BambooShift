mod workspace_support;

use serde_json::{Value, json};
use workspace_support::Fixture;

fn request() -> Value {
    json!({"kind":"bot","requestId":uuid::Uuid::new_v4().to_string(),
        "starter":{"id":"engineering-lead","language":"en"},
        "profile":{"name":"Customized engineering lead","role":"Reviewer",
            "instructions":"Keep this edited instruction.","avatar":"gem","color":"#ff871f"}})
}

async fn post(f: &Fixture, body: Value) -> (u16, Value) {
    f.request(
        "POST",
        &f.path("/creation-requests"),
        Some(body),
        false,
        Some(&f.owner),
    )
    .await
}

#[tokio::test]
async fn custom_starter_creates_edited_profile_and_packages_atomically_and_retries_preserve_choices()
 {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let body = request();
    let (status, created) = post(&f, body.clone()).await;
    assert_eq!(status, 201, "{created}");
    let bot = &created["agents"][0];
    assert_eq!(bot["name"], body["profile"]["name"]);
    assert_eq!(bot["instructions"], body["profile"]["instructions"]);
    let boot = f.bootstrap().await;
    assert_eq!(
        boot["agents"].as_array().unwrap().len(),
        initial["agents"].as_array().unwrap().len() + 1
    );
    let skills: Vec<_> = boot["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["agentId"] == bot["id"])
        .collect();
    assert_eq!(skills.len(), 5);
    assert!(skills.iter().all(|s| s["status"] == "active"));
    let engineering = skills
        .iter()
        .find(|s| s["name"] == "superpowers-engineering")
        .unwrap();
    assert_eq!(
        engineering["skillPackage"]["files"]
            .as_array()
            .unwrap()
            .len(),
        15
    );
    assert_eq!(engineering["skillPackage"]["frontmatter"]["license"], "MIT");
    assert!(boot["messages"].as_array().unwrap().is_empty());
    let (status, replay) = post(&f, body.clone()).await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay, created);
    assert_eq!(f.bootstrap().await["skills"], boot["skills"]);
    let disabled = f
        .request(
            "POST",
            &f.path(&format!(
                "/skills/{}/disable",
                engineering["id"].as_str().unwrap()
            )),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(disabled.0, 200, "{}", disabled.1);
    let foundation = skills.iter().find(|s| s["name"] == "browser-use").unwrap();
    assert_eq!(
        f.request(
            "DELETE",
            &f.path(&format!("/skills/{}", foundation["id"].as_str().unwrap())),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    let edited = f.bootstrap().await["skills"].clone();
    assert_eq!(post(&f, body.clone()).await.0, 200);
    assert_eq!(f.bootstrap().await["skills"], edited);
    let mut conflicting = body;
    conflicting["starter"]["id"] = json!("frontend-designer");
    assert_eq!(post(&f, conflicting).await.0, 409);
    f.close().await;
}

#[tokio::test]
async fn cancelled_invalid_and_non_owner_custom_starters_leave_no_bot_or_package() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let cancelled = request();
    let result = f
        .request(
            "POST",
            &f.path(&format!(
                "/creation-requests/{}/cancel",
                cancelled["requestId"].as_str().unwrap()
            )),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(result.0, 200, "{}", result.1);
    assert_eq!(post(&f, cancelled).await.0, 409);
    for (field, value) in [
        ("id", "unknown"),
        ("language", "invalid"),
        ("unexpected", "value"),
    ] {
        let mut invalid = request();
        invalid["starter"][field] = json!(value);
        assert_eq!(post(&f, invalid).await.0, 400);
    }
    let mut invalid_profile = request();
    invalid_profile["profile"]["permissions"] = json!("full");
    assert_eq!(post(&f, invalid_profile).await.0, 400);
    assert_eq!(
        f.request(
            "POST",
            &f.path("/creation-requests"),
            Some(request()),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    let after = f.bootstrap().await;
    for table in ["agents", "conversations", "skills", "messages"] {
        assert_eq!(after[table], initial[table], "{table}");
    }
    f.close().await;
}
