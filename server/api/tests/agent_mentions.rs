mod agent_delegation_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, has_tool_result, role, wait_gate};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;

async fn send(group: &Group, cid: &str, body: Value, member: bool) -> (u16, Value) {
    let actor = if member {
        &group.f.member
    } else {
        &group.f.owner
    };
    group
        .f
        .request(
            "POST",
            &group.f.path(&format!("/conversations/{cid}/messages")),
            Some(body),
            member,
            Some(actor),
        )
        .await
}

async fn wait_for(group: &Group, predicate: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let messages = group.store.list(Table::Messages).await.unwrap();
            if predicate(&messages) {
                break messages;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Group mention did not reach the expected message states")
}

fn prompt(body: &Value) -> Value {
    let input = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user")
        .unwrap();
    let content = &input["content"];
    let text = content
        .as_str()
        .or_else(|| {
            content
                .as_array()?
                .iter()
                .find_map(|block| block["text"].as_str())
        })
        .expect("Pi supplied a text prompt");
    serde_json::from_str(text).unwrap()
}

fn message<'a>(messages: &'a [Value], id: &Value) -> &'a Value {
    messages
        .iter()
        .find(|message| &message["id"] == id)
        .unwrap()
}

fn states(receipt: &Value) -> Vec<&str> {
    receipt["delivery"]["mentionTargets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| target["state"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn explicit_mentions_run_each_bot_once_in_order_and_keep_the_original_requester() {
    let group = Group::new().await;
    let ids = group.ids.clone();
    let original_owner = group.f.owner.clone();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (model_entered, model_release) = (entered.clone(), release.clone());
    let model = Model::new(Arc::new(move |body| {
        let (entered, release, ids, owner) = (model_entered.clone(), model_release.clone(), ids.clone(), original_owner.clone());
        Box::pin(async move {
            let input = prompt(&body);
            match input["content"].as_str().unwrap() {
                "Earlier task" => {
                    entered.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    finish("Earlier task completed")
                }
                "Later isolated task" => finish("Later task completed"),
                "@Synthetic colleague 2 summarize; @Synthetic colleague 1 verify" => {
                    let index = role(&body);
                    assert_eq!(input["requester"]["userId"], owner);
                    assert_eq!(input["groupRecipientId"], ids[index]);
                    assert_eq!(input["groupRecipients"]["agentIds"], json!([ids[2],ids[1]]));
                    assert!(!input["history"].to_string().contains("Later isolated task"));
                    if index == 2 && !has_tool_result(&body) {
                        return call("delegate", json!({"agentId":ids[1],"task":"Try to dispatch the next recipient twice."}));
                    }
                    if index == 2 {
                        assert!(body.to_string().contains("发起者已直接提及这位 Bot"));
                        finish("Summarizer replied")
                    } else {
                        assert_eq!(index, 1);
                        assert!(input["history"].to_string().contains("Summarizer replied"));
                        if !has_tool_result(&body) {
                            return call("suggest_app_connection", json!({"providerId":"notion","reason":"Review an app for the explicitly mentioned verifier."}));
                        }
                        finish("Verifier replied")
                    }
                }
                _ => panic!("Unexpected group input"),
            }
        })
    })).await;
    group.configure(&model).await;
    group.send("Earlier task", "followUp", false).await;
    wait_gate(&entered).await;
    let body = json!({"content":"@Synthetic colleague 2 summarize; @Synthetic colleague 1 verify",
        "clientId":"ordered-recipients","mode":"steer","mentions":{"agentIds":[group.ids[2],group.ids[1],group.ids[2]]}});
    let (status, receipt) = send(&group, &group.cid, body.clone(), false).await;
    assert_eq!(status, 202, "{receipt}");
    let input = &receipt["message"];
    assert_eq!(
        input["mentions"],
        json!({"agentIds":[group.ids[2],group.ids[1]]})
    );
    assert_eq!(states(input), ["queued", "queued"]);
    assert!(input["delivery"]["runId"].is_null());
    let mut duplicate = body.clone();
    duplicate["mentions"]["agentIds"] = json!([group.ids[2], group.ids[1]]);
    let (status, replay) = send(&group, &group.cid, duplicate, false).await;
    assert_eq!(status, 202);
    assert_eq!(replay["message"]["id"], input["id"]);
    let mut changed = body.clone();
    changed["mentions"]["agentIds"] = json!([group.ids[1], group.ids[2]]);
    assert_eq!(send(&group, &group.cid, changed, false).await.0, 409);
    group.send("Later isolated task", "steer", false).await;
    release.add_permits(1);
    let messages = wait_for(&group, |messages| {
        messages
            .iter()
            .any(|m| m["content"] == "Later task completed" && m["status"] == "done")
    })
    .await;
    assert_eq!(states(message(&messages, &input["id"])), ["done", "done"]);
    let replies = messages
        .iter()
        .filter(|m| m["role"] == "assistant" && m["metadata"]["inputMessageId"] == input["id"])
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["agentId"], group.ids[2]);
    assert_eq!(replies[1]["agentId"], group.ids[1]);
    assert_ne!(
        replies[0]["metadata"]["runId"],
        replies[1]["metadata"]["runId"]
    );
    assert!(
        messages
            .iter()
            .any(|m| m["content"] == "Earlier task completed" && m["status"] == "done")
    );
    let proposal = messages
        .iter()
        .find(|m| m["kind"] == "app_connection_proposal")
        .unwrap();
    assert_eq!(proposal["agentId"], group.ids[1]);
    assert_eq!(
        proposal["metadata"]["appConnectionProposal"]["requester"]["messageId"],
        input["id"]
    );
    assert_eq!(
        proposal["metadata"]["appConnectionProposal"]["requester"]["userId"],
        group.f.owner
    );
    assert_eq!(model.calls.lock().await.len(), 6);
    assert_eq!(
        send(&group, &group.cid, body, false).await.1["message"]["id"],
        input["id"]
    );
    group.close().await;
}

#[tokio::test]
async fn everyone_reuses_the_original_thread_snapshot_and_only_the_requester_can_stop() {
    let group = Group::new().await;
    group.store.put(Table::Messages, &json!({"id":"mention-thread-root","conversationId":group.cid,"agentId":group.ids[0],
        "role":"assistant","kind":"text","status":"done","content":"Thread anchor","createdAt":"2026-11-07T01:00:00Z"})).await.unwrap();
    let first_started = Arc::new(Semaphore::new(0));
    let first_release = Arc::new(Semaphore::new(0));
    let third_started = Arc::new(Semaphore::new(0));
    let third_release = Arc::new(Semaphore::new(0));
    let (first, release, third, third_gate) = (
        first_started.clone(),
        first_release.clone(),
        third_started.clone(),
        third_release.clone(),
    );
    let (ids, requester) = (group.ids.clone(), group.f.member.clone());
    let model = Model::new(Arc::new(move |body| {
        let (first, release, third, third_gate, ids, requester) = (
            first.clone(),
            release.clone(),
            third.clone(),
            third_gate.clone(),
            ids.clone(),
            requester.clone(),
        );
        Box::pin(async move {
            let input = prompt(&body);
            if input["content"] == "Separate main message" {
                assert!(input["threadOrigin"].is_null());
                assert!(!input["history"].to_string().contains("Thread update"));
                return finish("Separate main response");
            }
            assert_eq!(input["threadOrigin"]["id"], "mention-thread-root");
            assert_eq!(input["requester"]["userId"], requester);
            assert_eq!(
                input["groupRecipients"],
                json!({"agentIds":ids,"everyone":true})
            );
            assert!(
                !input["history"]
                    .to_string()
                    .contains("Separate main message")
            );
            match role(&body) {
                0 => {
                    first.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    finish("First Bot replied in thread")
                }
                2 => {
                    third.add_permits(1);
                    third_gate.acquire().await.unwrap().forget();
                    finish("Stopped Bot must not reply")
                }
                _ => panic!("A removed or stopped recipient reached the model"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let body = json!({"content":"Thread update","clientId":"all-recipients","threadRootId":"mention-thread-root","mentions":{"everyone":true}});
    let (status, receipt) = send(&group, &group.cid, body.clone(), true).await;
    assert_eq!(status, 202, "{receipt}");
    let input = &receipt["message"];
    assert_eq!(
        input["mentions"],
        json!({"agentIds":group.ids,"everyone":true})
    );
    assert_eq!(input["replyTo"]["id"], "mention-thread-root");
    wait_gate(&first_started).await;
    let agents = group.store.list(Table::Agents).await.unwrap();
    let newcomer = agents
        .iter()
        .find(|agent| {
            agent["id"]
                .as_str()
                .is_some_and(|id| !group.ids.iter().any(|original| original == id))
        })
        .unwrap();
    let patched = group
        .f
        .request(
            "PATCH",
            &group.f.path(&format!("/conversations/{}", group.cid)),
            Some(json!({"agentIds":[group.ids[0],group.ids[2],group.ids[3],newcomer["id"]]})),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(patched.0, 200, "{}", patched.1);
    let (status, replay) = send(&group, &group.cid, body, true).await;
    assert_eq!(status, 202);
    assert_eq!(replay["message"]["id"], input["id"]);
    assert_eq!(replay["message"]["mentions"], input["mentions"]);
    let separate = send(
        &group,
        &group.cid,
        json!({"content":"Separate main message","clientId":"separate-main"}),
        true,
    )
    .await;
    assert_eq!(separate.0, 202, "{}", separate.1);
    first_release.add_permits(1);
    wait_gate(&third_started).await;
    let stop = group.f.path(&format!(
        "/conversations/{}/stop?threadRootId=mention-thread-root",
        group.cid
    ));
    assert_eq!(
        group
            .f
            .request("POST", &stop, None, false, Some(&group.f.owner))
            .await
            .0,
        403
    );
    let wrong_scope = group
        .f
        .path(&format!("/conversations/{}/stop?scope=main", group.cid));
    assert_eq!(
        group
            .f
            .request("POST", &wrong_scope, None, true, Some(&group.f.member))
            .await
            .0,
        409
    );
    assert_eq!(
        group
            .f
            .request("POST", &stop, None, true, Some(&group.f.member))
            .await
            .0,
        200
    );
    let messages = wait_for(&group, |messages| {
        messages
            .iter()
            .any(|m| m["content"] == "Separate main response" && m["status"] == "done")
    })
    .await;
    assert_eq!(
        states(message(&messages, &input["id"])),
        ["done", "interrupted", "cancelled", "cancelled"]
    );
    assert!(
        messages
            .iter()
            .filter(|m| m["metadata"]["inputMessageId"] == input["id"])
            .all(|m| m["threadRootId"] == "mention-thread-root")
    );
    assert_eq!(model.calls.lock().await.len(), 3);
    third_release.add_permits(1);
    group.close().await;
}

#[tokio::test]
async fn restart_preserves_completed_recipients_and_interrupts_remaining_ones_without_replay() {
    let group = Group::new().await;
    let input_id = "stored-group-mention";
    group.store.put(Table::Messages, &json!({
        "id":input_id,"conversationId":group.cid,"userId":group.f.owner,"role":"user","kind":"text",
        "content":"A synthetic message present before recovery","createdAt":"2026-11-07T01:00:00Z",
        "mentions":{"agentIds":[group.ids[0],group.ids[1],group.ids[2]]},
        "delivery":{"state":"delivered","mode":"followUp","clientId":"stored-group-mention",
        "agentId":group.ids[0],"runId":"finished-run","mentionTargets":[
            {"agentId":group.ids[0],"state":"done","runId":"finished-run"},
            {"agentId":group.ids[1],"state":"delivered","runId":"interrupted-run"},
            {"agentId":group.ids[2],"state":"queued"}
        ]}
    })).await.unwrap();
    let config = (*group.f.state.config).clone();
    group.f.state.close().await;
    let restarted = openbot_backend::db::State::open(config).await.unwrap();
    let restored = restarted
        .workspace
        .get(&group.f.workspace, &group.f.workspace)
        .await
        .unwrap();
    let input = restored
        .get(Table::Messages, input_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(states(&input), ["done", "interrupted", "interrupted"]);
    assert_eq!(input["delivery"]["state"], "delivered");
    assert!(
        restarted
            .agent_runs
            .requests(&group.f.workspace)
            .await
            .is_empty()
    );
    restarted.close().await;
    group.close().await;
}

#[tokio::test]
async fn malformed_conflicting_private_and_nonmember_mentions_fail_before_persistence() {
    let group = Group::new().await;
    let boot = group.f.bootstrap().await;
    let direct = boot["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|chat| chat["isGroup"] != true)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let base = json!({"content":"Reject invalid mention","clientId":"invalid-mentions"});
    for (cid, recipients, extra, expected_status, code) in [
        (
            direct,
            json!({"everyone":true}),
            json!({}),
            400,
            "CHAT_MENTIONS_GROUP_REQUIRED",
        ),
        (
            &group.cid,
            json!({"agentIds":["foreign-bot"]}),
            json!({}),
            409,
            "CHAT_MENTION_UNAVAILABLE",
        ),
        (
            &group.cid,
            json!({"agentIds":[]}),
            json!({}),
            400,
            "CHAT_MENTIONS_INVALID",
        ),
        (
            &group.cid,
            json!({"everyone":false}),
            json!({}),
            400,
            "CHAT_MENTIONS_INVALID",
        ),
        (
            &group.cid,
            json!({"everyone":true,"agentIds":[]}),
            json!({}),
            400,
            "CHAT_MENTIONS_INVALID",
        ),
        (
            &group.cid,
            json!({"everyone":true}),
            json!({"agentId":group.ids[0]}),
            400,
            "CHAT_MENTIONS_INVALID",
        ),
        (
            &group.cid,
            json!({"everyone":true}),
            json!({"appContext":null}),
            400,
            "CHAT_MENTIONS_INVALID",
        ),
    ] {
        let mut body = base.clone();
        body["mentions"] = recipients;
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (status, error) = send(&group, cid, body, true).await;
        assert_eq!(status, expected_status, "{error}");
        assert_eq!(error["code"], code);
    }
    assert!(
        !group
            .store
            .list(Table::Messages)
            .await
            .unwrap()
            .iter()
            .any(|message| message["content"] == "Reject invalid mention")
    );
    group.close().await;
}
