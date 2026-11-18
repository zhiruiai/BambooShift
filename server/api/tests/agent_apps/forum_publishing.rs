use crate::agent_apps_support::{
    Group, Model, call, decide, finish, pending, root_result, setup_with_tools, tool_result,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

const CREATE_TOPIC: &str = "discourse_create_topic";

fn topic_arguments() -> Value {
    json!({"title":"A sample release", "raw":"The synthetic release is ready for review.", "category_id":8})
}

async fn install_publishing_skill(group: &Group) -> Value {
    let catalog: Vec<Value> =
        serde_json::from_str(include_str!("../../../../mobile/assets/skills/en.json")).unwrap();
    let assets: Value = serde_json::from_str(include_str!(
        "../../../../shared/skill-workflow-resources.json"
    ))
    .unwrap();
    let name = "forum-publishing";
    let recipe = catalog.iter().find(|item| item["id"] == name).unwrap();
    let package = &assets[name];
    let files: Vec<Value> = package["files"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, body)| json!({"path":path, "base64":STANDARD.encode(body.as_str().unwrap())}))
        .collect();
    let (status, skill) = group.f.request(
        "POST", &group.f.path("/skills/install"),
        Some(json!({"agentId":group.ids[0], "name":name, "description":recipe["description"],
            "content":format!("{}\n\n{}\n", recipe["content"].as_str().unwrap().trim_end(), package["instruction"]["en"].as_str().unwrap()),
            "expectedActiveId":null,
            "skillPackage":{"root":name, "files":files, "frontmatter":{"license":package["license"],
                "compatibility":package["compatibility"],"metadata":{"source":package["source"],"title":recipe["name"]}}}})),
        false, Some(&group.f.owner)
    ).await;
    assert_eq!(status, 201, "{skill}");
    skill
}

#[tokio::test]
async fn approved_forum_topic_returns_its_permalink_and_is_sent_once() {
    check_post(true).await;
}

#[tokio::test]
async fn rejected_forum_write_returns_the_remote_error_without_a_permalink_or_retry() {
    check_post(false).await;
}

async fn check_post(accepts_post: bool) {
    let tool = json!({
        "name": CREATE_TOPIC,
        "description": "Create a topic in this Discourse community.",
        "inputSchema": {
            "type":"object", "required":["title","raw"],
            "properties":{"title":{"type":"string"}, "raw":{"type":"string"}, "category_id":{"type":"integer"}}
        }
    });
    let (group, server, connection) = setup_with_tools("Forum sandbox", Some(vec![tool])).await;
    *server.remote.tool_responder.lock().await = Some(Box::new(move |params| {
        assert_eq!(params["name"], CREATE_TOPIC);
        assert_eq!(params["arguments"], topic_arguments());
        if accepts_post {
            let topic = json!({"id":817, "topic_id":314, "slug":"a-sample-release", "title":"A sample release",
                "username":"sample-contributor", "requested_author":null, "author_applied":null});
            json!({"content":[{"type":"text","text":topic.to_string()}], "structuredContent":topic, "isError":false})
        } else {
            json!({"content":[{"type":"text","text":"The category is closed for new topics."}], "isError":true})
        }
    }));
    let skill = install_publishing_skill(&group).await;
    let skill_id = skill["id"].clone();
    let id = connection["id"].clone();
    let step = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |request| {
        let (id, skill_id) = (id.clone(), skill_id.clone());
        let step = step.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match step {
                0 => call("read_skill", json!({"skillId":skill_id})),
                1 => {
                    let loaded = tool_result(&request);
                    assert_eq!(loaded["skillPackage"]["root"], "forum-publishing");
                    assert!(loaded["content"].as_str().unwrap().contains(CREATE_TOPIC));
                    call("list_app_tools", json!({"connectionId":id}))
                }
                2 => {
                    assert_eq!(tool_result(&request)["tools"][0]["name"], CREATE_TOPIC);
                    call("app_action", json!({"connectionId":id, "toolName":CREATE_TOPIC, "arguments":topic_arguments()}))
                }
                3 => {
                    let receipt = tool_result(&request);
                    let result = &receipt["result"];
                    assert_eq!(result["isError"], !accepts_post);
                    finish(result["text"].as_str().unwrap())
                }
                _ => panic!("A completed publishing attempt must not be retried"),
            }
        })
    })).await;
    group.configure(&model).await;
    let (status, queued) = group.f.request(
        "POST",
        &group.f.path(&format!("/conversations/{}/messages", group.cid)),
        Some(json!({"content":"Publish the sample release topic in category 8.", "clientId":"forum-topic",
            "agentId":group.ids[0], "skillId":skill["id"], "appContext":{"connectionId":connection["id"],"revision":connection["revision"]}})),
        true, Some(&group.f.member),
    ).await;
    assert_eq!(status, 202, "{queued}");

    let proposal = pending(&group.store).await;
    assert_eq!(proposal["toolName"], CREATE_TOPIC);
    assert_eq!(proposal["arguments"], topic_arguments());
    assert_eq!(proposal["requester"]["messageId"], queued["message"]["id"]);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 0);
    assert_eq!(decide(&group, &proposal, true).await.0, 200);

    let messages = group.done().await;
    let card = messages
        .iter()
        .find(|m| m["metadata"]["appAction"]["id"] == proposal["id"])
        .unwrap();
    let answer = root_result(&messages, &queued["message"]);
    let tool_result = &card["metadata"]["appAction"]["result"];
    assert_eq!(answer["content"], tool_result["text"]);
    if accepts_post {
        assert_eq!(card["status"], "done");
        let receipt = tool_result["text"].as_str().unwrap();
        let topic: Value = receipt
            .lines()
            .find_map(|line| serde_json::from_str(line).ok())
            .unwrap();
        assert_eq!(topic["id"], 817);
        assert_eq!(topic["topic_id"], 314);
        let expected_link = format!("{}/t/314", server.remote.origin);
        assert_eq!(receipt.lines().last(), Some(expected_link.as_str()));
    } else {
        assert_eq!(card["status"], "error");
        assert_eq!(answer["content"], "The category is closed for new topics.");
    }
    assert_eq!(decide(&group, &proposal, true).await.0, 409);
    assert_eq!(server.remote.calls.load(Ordering::SeqCst), 1);
    group.close().await;
}
