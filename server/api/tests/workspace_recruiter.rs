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

#[tokio::test]
async fn unchanged_legacy_chinese_recruiter_is_upgraded_in_place_with_its_chat() {
    let f = Fixture::new().await;
    // This was the shipped profile before the dedicated recruiter entry was added.
    let legacy = json!({
        "name":"AI 同事招募员",
        "role":"复用现有 Bot，补齐团队职责",
        "description":"按产品目标检查角色缺口，提出可审核的 AI 同事或团队方案。",
        "instructions":r#"你是 AI 同事招募员，负责配置 BambooShift 的 Bot 团队，不招聘或联系真人。先明确成果、验收标准、已有项目和缺少的职责；优先复用合适 Bot，避免只改名字重复创建。

用 list_peers 查看当前可见同事及真实标识。普通 Bot 私聊的可见范围可能只有自己，不能据此判断整个空间没有其他 Bot。若目录不足，让用户在现有智能组队入口检查完整目录或交由已选主 Bot 协调；不要猜测 agentId，也不擅自把自己设为主 Bot。只有有明确新增需要时提出新角色。

用户要求单个 AI 同事且当前提供 propose_bot 时，提交 name、role、description、instructions、avatar、color，明确输入、输出、工具前提和验收标准。该工具只在拥有者与本地 Bot 的人工私聊等受支持场景出现。需要团队且提供 propose_team 时，提交 {goal,draft}，draft 仅含 title、summary、leadKey、members，2–6 位互补成员。复用项用 {key,kind:"reuse",agentId,assignment}；新增项用 {key,kind:"create",name,role,description,instructions,avatar,color,assignment}。key 唯一，leadKey 指向成员，avatar 选 orb/drop/leaf/spark/gem/arch，color 用 #RRGGBB。角色分工写出前置交付、工作范围、输出与复查人；不要添加不存在的 dependsOn 或计划执行字段。

每轮只提出一份团队方案，用户可在原卡片中编辑、复用同事并确认。工具不存在时给出文字方案和现有模板入口，不声称已经创建。确认前不开始开发、不发消息、不安排例行任务、不变更连接或权限。未知创建结果先查看原卡片或回执，不重复招募。已经存在的软件产品团队应调整分工，不再创建同名队伍。"#,
        "avatar":"arch",
        "color":"#8b5eaa",
    });
    let (code, old) = f
        .request(
            "POST",
            &f.path("/agents"),
            Some(legacy),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(code, 201, "{old}");
    let snapshot = f.bootstrap().await;
    let chat = snapshot["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|chat| chat["agentIds"] == json!([old["id"]]))
        .unwrap();
    let opened = open(&f, "en").await;
    assert_eq!(opened["agentId"], old["id"]);
    assert_eq!(opened["conversationId"], chat["id"]);
    assert_eq!(opened["agent"]["name"], "招聘助理");
    assert_eq!(opened["conversation"]["title"], "招聘助理");
    assert_ne!(opened["agent"]["configRevision"], old["configRevision"]);
    assert_ne!(opened["agent"]["instructions"], old["instructions"]);
    assert_eq!(open(&f, "en").await, opened);
    f.close().await;
}
