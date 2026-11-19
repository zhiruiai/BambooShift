mod workspace_support;

use openbot_backend::{db::State, workspace::Table};
use serde_json::{Value, json};
use workspace_support::Fixture;

async fn open(f: &Fixture, locale: &str) -> Value {
    let (code, body) = f
        .request(
            "POST",
            &f.path("/recruiter"),
            Some(json!({"locale":locale})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["agent"]["id"], body["agentId"]);
    assert_eq!(body["conversation"]["id"], body["conversationId"]);
    assert_eq!(body["conversation"]["agentIds"], json!([body["agentId"]]));
    assert_eq!(body["conversation"]["isGroup"], false);
    body
}

#[tokio::test]
async fn concurrent_first_open_creates_one_local_recruiter_without_messages_or_model() {
    let mut f = Fixture::new().await;
    let before = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let mut events = store.subscribe();
    let (first, second, third) =
        tokio::join!(open(&f, "zh-CN"), open(&f, "zh-CN"), open(&f, "zh-CN"));
    assert_eq!(first, second);
    assert_eq!(first, third);
    assert_eq!(first["agent"]["name"], "招聘助理");
    assert_eq!(first["agent"]["avatar"], "arch");
    assert_eq!(first["agent"]["color"], "#8b5eaa");
    assert_eq!(first["agent"]["modelConfigured"], false);
    assert_eq!(first["conversation"]["unread"], 0);
    assert!(first["agent"].get("apiKey").is_none());
    assert_eq!(open(&f, "en").await, first);
    let after = f.bootstrap().await;
    assert_eq!(
        after["agents"].as_array().unwrap().len(),
        before["agents"].as_array().unwrap().len() + 1
    );
    assert_eq!(
        after["conversations"].as_array().unwrap().len(),
        before["conversations"].as_array().unwrap().len() + 1
    );
    for field in ["messages", "routines", "apps", "primaryBot", "settings"] {
        assert_eq!(before[field], after[field], "{field}");
    }
    let skills = store.list(Table::Skills).await.unwrap();
    let recruiter_skills = skills
        .iter()
        .filter(|skill| skill["agentId"] == first["agentId"])
        .collect::<Vec<_>>();
    assert_eq!(recruiter_skills.len(), 5);
    let recruiter_skills: Vec<_> = recruiter_skills
        .into_iter()
        .filter(|skill| skill["name"] == "bot-design")
        .collect();
    assert_eq!(recruiter_skills.len(), 1);
    assert_eq!(recruiter_skills[0]["name"], "bot-design");
    assert_eq!(recruiter_skills[0]["status"], "active");
    assert_eq!(recruiter_skills[0]["skillPackage"]["root"], "bot-design");
    assert_eq!(
        recruiter_skills[0]["skillPackage"]["files"][1]["path"],
        "assets/bot-brief.json"
    );
    assert_eq!(
        recruiter_skills[0]["skillPackage"]["files"][2]["path"],
        "references/checklist.md"
    );
    assert_eq!(events.try_recv().unwrap().event, "update");
    assert!(events.try_recv().is_err());
    let config = f.state.config.clone();
    f.state.close().await;
    f.state = State::open((*config).clone()).await.unwrap();
    assert_eq!(open(&f, "en").await, first);
    f.close().await;
}

#[tokio::test]
async fn workspace_owner_and_expected_identity_are_required() {
    let f = Fixture::new().await;
    let initial = f.bootstrap().await;
    let request = Some(json!({"locale":"en"}));
    for (path, member, expected) in [
        (f.path("/recruiter"), true, Some(f.member.as_str())),
        (f.path("/recruiter"), false, None),
        (
            format!("/api/workspaces/{}/recruiter", f.foreign),
            false,
            Some(f.owner.as_str()),
        ),
    ] {
        let (code, body) = f
            .request("POST", &path, request.clone(), member, expected)
            .await;
        assert_eq!(code, 403, "{body}");
    }
    for body in [
        json!({"locale":"ja"}),
        json!({"locale":"en", "agentId":"chosen"}),
        json!({}),
    ] {
        let (code, error) = f
            .request(
                "POST",
                &f.path("/recruiter"),
                Some(body),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(code, 400, "{error}");
    }
    let after = f.bootstrap().await;
    assert_eq!(initial["agents"], after["agents"]);
    assert_eq!(initial["conversations"], after["conversations"]);
    let created = open(&f, "en").await;
    assert_eq!(created["agent"]["name"], "AI Staff Recruiter");
    let (code, other) = f
        .request(
            "POST",
            &format!("/api/workspaces/{}/recruiter", f.foreign),
            request,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(code, 200, "{other}");
    assert_ne!(other["agentId"], created["agentId"]);
    assert_ne!(other["conversationId"], created["conversationId"]);
    f.close().await;
}

#[tokio::test]
async fn an_exact_template_is_reused_and_deleted_direct_chat_is_recreated_for_the_same_bot() {
    let f = Fixture::new().await;
    let catalog: Value =
        serde_json::from_str(include_str!("../../../shared/bot-starter-templates.json")).unwrap();
    let starter = &catalog["recruitment"];
    let chinese = &starter["locales"]["zh-CN"];
    let name = &chinese["name"];
    let (code, same_name) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(json!({"name":name})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 201, "{same_name}");
    let profile = json!({
        "name":name,"role":chinese["role"],"description":chinese["description"],
        "instructions":chinese["instructions"],"avatar":starter["avatar"],"color":starter["color"],
    });
    let (code, exact) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(profile),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 201, "{exact}");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let chats = store.list(Table::Conversations).await.unwrap();
    let direct = chats
        .iter()
        .find(|chat| chat["agentIds"] == json!([exact["id"]]))
        .unwrap();
    let first = open(&f, "en").await;
    assert_eq!(first["agentId"], exact["id"]);
    assert_ne!(first["agentId"], same_name["id"]);
    assert_eq!(first["conversationId"], direct["id"]);
    assert_eq!(
        store.list(Table::Conversations).await.unwrap().len(),
        chats.len()
    );

    let agent_path = f.path(&format!("/agents/{}", exact["id"].as_str().unwrap()));
    let (code, edited) = f
        .request(
            "PATCH",
            &agent_path,
            Some(json!({"name":"我的招聘助理"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 200, "{edited}");
    let chat_path = f.path(&format!(
        "/conversations/{}",
        direct["id"].as_str().unwrap()
    ));
    let (code, deleted) = f
        .request("DELETE", &chat_path, None, false, Some(&f.owner))
        .await;
    assert_eq!(code, 200, "{deleted}");
    let recovered = open(&f, "en").await;
    assert_eq!(recovered["agentId"], exact["id"]);
    assert_eq!(recovered["agent"]["name"], "我的招聘助理");
    assert_eq!(recovered["conversation"]["title"], "我的招聘助理");
    assert_ne!(recovered["conversationId"], direct["id"]);
    assert_eq!(open(&f, "zh-CN").await, recovered);
    assert_eq!(
        store.list(Table::Conversations).await.unwrap().len(),
        chats.len()
    );
    f.close().await;
}

// Unmodified snapshots from both generations of the shipped BambooShift catalog.
fn historical_profiles() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/shared/legacy-recruiter-profiles.json"
    ))
    .unwrap()
}

async fn create_historical_recruiter(f: &Fixture, profile: Value, bound: bool) -> (Value, Value) {
    let (code, agent) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(profile),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 201, "{agent}");
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let chat = store
        .list(Table::Conversations)
        .await
        .unwrap()
        .into_iter()
        .find(|chat| chat["agentIds"] == json!([agent["id"]]))
        .unwrap();
    if bound {
        store
            .put(
                Table::Settings,
                &json!({
                    "id": "builtin-recruiter", "agentId": agent["id"], "conversationId": chat["id"]
                }),
            )
            .await
            .unwrap();
    }
    (agent, chat)
}

#[tokio::test]
async fn unchanged_released_recruiters_keep_their_bots_chats_and_locale_after_upgrade() {
    let profiles = historical_profiles();
    let current: Value =
        serde_json::from_str(include_str!("../../../shared/bot-starter-templates.json")).unwrap();
    for (generation, bound) in [("ca41ab8", false), ("3d28810", false), ("3d28810", true)] {
        for (locale, requested) in [("zh-CN", "en"), ("en", "zh-CN")] {
            let f = Fixture::new().await;
            let (old, chat) =
                create_historical_recruiter(&f, profiles[generation][locale].clone(), bound).await;
            let opened = open(&f, requested).await;
            let expected = &current["recruitment"]["locales"][locale];
            assert_eq!(opened["agentId"], old["id"], "{generation} {locale}");
            assert_eq!(opened["conversationId"], chat["id"]);
            assert_eq!(opened["agent"]["instructions"], expected["instructions"]);
            assert_eq!(opened["agent"]["name"], expected["name"]);
            assert_eq!(opened["conversation"]["title"], expected["name"]);
            assert_ne!(opened["agent"]["configRevision"], old["configRevision"]);
            assert_eq!(open(&f, requested).await, opened);
            f.close().await;
        }
    }
}

#[tokio::test]
async fn a_modified_old_profile_is_never_adopted_or_overwritten_during_the_rename() {
    for bound in [false, true] {
        let f = Fixture::new().await;
        let mut profile = historical_profiles()["3d28810"]["en"].clone();
        profile["instructions"] = json!(format!(
            "{}\nOnly recruit the roles listed in this team's staffing plan.",
            profile["instructions"].as_str().unwrap()
        ));
        let (old, chat) = create_historical_recruiter(&f, profile, bound).await;
        let opened = open(&f, "en").await;
        assert_eq!(opened["agentId"] == old["id"], bound);
        assert_eq!(opened["conversationId"] == chat["id"], bound);
        let store = f
            .state
            .workspace
            .get(&f.workspace, &f.workspace)
            .await
            .unwrap();
        let saved = store
            .get(Table::Agents, old["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved["instructions"], old["instructions"]);
        assert_eq!(saved["configRevision"], old["configRevision"]);
        f.close().await;
    }
}
