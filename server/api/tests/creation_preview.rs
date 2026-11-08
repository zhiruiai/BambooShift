mod agent_delegation_support;
mod workspace_support;

use agent_delegation_support::{Fixture, Model, finish, wait_gate};
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;

fn bot_draft() -> Value {
    json!({"name":"Research Partner","role":"Researcher","description":"Compare sources.",
        "instructions":"Verify evidence and summarize the findings.","avatar":"spark","color":"#AABBCC"})
}

fn theme_draft(motif: &str) -> Value {
    json!({"name":"星空伙伴","motif":motif,"colors":["#AABBCC","#18293A","#DDEEFF"],
        "badge":"moon","backdrop":"halo"})
}

fn input(kind: &str, brief: &str, language: &str) -> Value {
    json!({"kind":kind,"brief":brief,"language":language})
}

async fn configure(fixture: &Fixture, model: &Model) {
    let (status, result) = fixture
        .request(
            "PUT",
            &fixture.path("/settings"),
            Some(model.config()),
            false,
            Some(&fixture.owner),
        )
        .await;
    assert_eq!(status, 200, "{result}");
}

async fn preview(fixture: &Fixture, body: Value) -> (u16, Value) {
    fixture
        .request(
            "POST",
            &fixture.path("/creation-preview"),
            Some(body),
            false,
            Some(&fixture.owner),
        )
        .await
}

async fn storage_counts(store: &WorkspaceStore) -> [usize; 6] {
    let mut counts = [0; 6];
    for (index, table) in [Table::Agents, Table::Conversations, Table::Messages]
        .into_iter()
        .enumerate()
    {
        counts[index] = store.list(table).await.unwrap().len();
    }
    for (index, table) in [
        "model_usage",
        "creation_requests",
        "creation_request_cancellations",
    ]
    .into_iter()
    .enumerate()
    {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&store.pool)
            .await
            .unwrap();
        counts[index + 3] = count as usize;
    }
    counts
}

#[tokio::test]
async fn owner_gets_tool_free_bot_and_theme_drafts_without_persisting_anything() {
    let fixture = Fixture::new().await;
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            assert!(body.get("tools").is_none_or(|tools| tools == &json!([])));
            let wire = body.to_string();
            if wire.contains("synthetic research specialist") {
                assert!(wire.contains(r#"\"language\":\"en\""#));
                assert!(wire.contains("exactly one JSON object"));
                return finish(&bot_draft().to_string());
            }
            assert!(wire.contains(r#"\"language\":\"zh-CN\""#));
            let motif = if wire.contains("synthetic chick theme") {
                "chicks"
            } else {
                assert!(wire.contains("synthetic elephant theme"));
                "elephants"
            };
            finish(&format!("```json\n{}\n```", theme_draft(motif)))
        })
    }))
    .await;
    configure(&fixture, &model).await;
    let store = fixture
        .state
        .workspace
        .get(&fixture.workspace, &fixture.workspace)
        .await
        .unwrap();
    let before = storage_counts(&store).await;

    let mut expected = bot_draft();
    expected["avatarImageId"] = Value::Null;
    expected["color"] = json!("#aabbcc");
    assert_eq!(
        preview(
            &fixture,
            input("bot", "synthetic research specialist", "en")
        )
        .await,
        (200, json!({"kind":"bot","profile":expected}))
    );
    for (brief, motif) in [
        ("synthetic chick theme", "chicks"),
        ("synthetic elephant theme", "elephants"),
    ] {
        let mut expected = theme_draft(motif);
        expected["colors"] = json!(["#aabbcc", "#18293a", "#ddeeff"]);
        assert_eq!(
            preview(&fixture, input("theme", brief, "zh-CN")).await,
            (200, json!({"kind":"theme","theme":expected}))
        );
    }
    assert_eq!(model.calls.lock().await.len(), 3);
    assert_eq!(storage_counts(&store).await, before);
    fixture.close().await;
}

#[tokio::test]
async fn preview_rejects_bad_actors_and_requests_before_model_access() {
    let fixture = Fixture::new().await;
    let model = Model::new(Arc::new(|_| Box::pin(async { finish("{}") }))).await;
    configure(&fixture, &model).await;
    let path = fixture.path("/creation-preview");
    for (member, expected) in [
        (true, Some(fixture.member.as_str())),
        (false, Some(fixture.member.as_str())),
        (false, None),
    ] {
        let result = fixture
            .request(
                "POST",
                &path,
                Some(input("bot", "draft", "en")),
                member,
                expected,
            )
            .await;
        assert_eq!(result.0, 403, "{}", result.1);
    }
    for invalid in [
        json!({"kind":"bot","brief":"draft","language":"en","profileId":"other"}),
        json!({"kind":"bot","brief":"draft"}),
        input("group", "draft", "en"),
        input("theme", "draft", "de"),
        input("bot", "  ", "en"),
        input("bot", "draft\0", "en"),
        input("theme", &"x".repeat(3001), "en"),
    ] {
        let result = preview(&fixture, invalid).await;
        assert_eq!(result.0, 400, "{}", result.1);
    }
    assert!(model.calls.lock().await.is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn preview_rejects_unsafe_or_inexact_model_output() {
    let fixture = Fixture::new().await;
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            let wire = body.to_string();
            let mut draft = if wire.contains("synthetic profile") {
                bot_draft()
            } else {
                theme_draft("companions")
            };
            if wire.contains("extra image field") {
                draft["avatarImageId"] = Value::Null;
            } else if wire.contains("missing instructions") {
                draft.as_object_mut().unwrap().remove("instructions");
            } else if wire.contains("duplicate color values") {
                draft["colors"][1] = json!("#aabbcc");
            } else if wire.contains("unsafe name value") {
                draft["name"] = json!("https://example.invalid/theme");
            } else if wire.contains("additional CSS field") {
                draft["css"] = json!("background:red");
            } else {
                assert!(wire.contains("unknown motif value"));
                draft["motif"] = json!("dragons");
            }
            finish(&draft.to_string())
        })
    }))
    .await;
    configure(&fixture, &model).await;
    for (kind, brief) in [
        ("bot", "synthetic profile extra image field"),
        ("bot", "synthetic profile missing instructions"),
        ("theme", "duplicate color values"),
        ("theme", "unsafe name value"),
        ("theme", "additional CSS field"),
        ("theme", "unknown motif value"),
    ] {
        let result = preview(&fixture, input(kind, brief, "en")).await;
        assert_eq!(result.0, 502, "{}", result.1);
        assert_eq!(result.1["code"], "INVALID_CREATION_PREVIEW");
    }
    fixture.close().await;
}

#[tokio::test]
async fn preview_drops_an_in_flight_draft_when_the_actor_loses_ownership() {
    let fixture = Fixture::new().await;
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let model = Model::new(Arc::new({
        let (entered, release) = (entered.clone(), release.clone());
        move |_| {
            let (entered, release) = (entered.clone(), release.clone());
            Box::pin(async move {
                entered.add_permits(1);
                wait_gate(&release).await;
                finish(&bot_draft().to_string())
            })
        }
    }))
    .await;
    configure(&fixture, &model).await;
    let (result, ()) = tokio::join!(
        preview(&fixture, input("bot", "synthetic delayed profile", "en")),
        async {
            wait_gate(&entered).await;
            sqlx::query("UPDATE memberships SET role='member' WHERE workspace_id=? AND user_id=?")
                .bind(&fixture.workspace)
                .bind(&fixture.owner)
                .execute(&fixture.db)
                .await
                .unwrap();
            release.add_permits(1);
        }
    );
    assert_eq!(result.0, 403, "{}", result.1);
    assert!(result.1.get("profile").is_none());
    fixture.close().await;
}
