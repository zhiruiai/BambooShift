mod agent_queue_support;
mod workspace_support;

use agent_queue_support::{Fixture, Model, submit, wait};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};

async fn send(f: &Fixture, cid: &str, body: Value) -> (u16, Value) {
    f.request(
        "POST",
        &f.path(&format!("/conversations/{cid}/messages")),
        Some(body),
        false,
        Some(&f.owner),
    )
    .await
}

async fn seed(f: &Fixture, cid: &str, id: &str, content: &str) {
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    store
        .put(
            Table::Messages,
            &json!({
                "id":id,"conversationId":cid,"role":"assistant","kind":"text",
                "status":"done","content":content,"createdAt":"2026-11-06T00:00:00Z"
            }),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn thread_validation_and_replays_cannot_switch_roots_or_quote_another_scope() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    seed(&f, cid, "root-a", "Authorized root").await;
    seed(&f, cid, "root-b", "Another result").await;
    seed(&f, "other-chat", "foreign", "Foreign root").await;
    let body =
        json!({"content":"A thread reply","clientId":"thread-first","threadRootId":"root-a"});
    let (status, receipt) = send(&f, cid, body.clone()).await;
    assert_eq!(status, 202, "{receipt}");
    let reply = &receipt["message"];
    assert_eq!(reply["threadRootId"], "root-a");
    assert_eq!(reply["replyTo"]["id"], "root-a");
    assert_eq!(reply["replyTo"]["content"], "Authorized root");
    let mut explicit_root = body.clone();
    explicit_root["replyToMessageId"] = json!("root-a");
    let (_, replay) = send(&f, cid, explicit_root).await;
    assert_eq!(replay["message"]["id"], reply["id"]);
    let mut different = body;
    different["threadRootId"] = json!("root-b");
    assert_eq!(send(&f, cid, different).await.0, 409);
    for rejected in [
        json!({"threadRootId":"foreign"}),
        json!({"threadRootId":"missing"}),
        json!({"threadRootId":reply["id"]}),
        json!({"threadRootId":"root-b","replyToMessageId":reply["id"]}),
        json!({"threadRootId":"root-a","replyToMessageId":"root-b"}),
        json!({"replyToMessageId":reply["id"]}),
    ] {
        let mut rejected = rejected;
        rejected["content"] = json!("Wrong scope");
        rejected["clientId"] = json!(uuid::Uuid::new_v4().to_string());
        let (status, error) = send(&f, cid, rejected).await;
        assert_eq!(status, 409, "{error}");
        assert_eq!(error["code"], "THREAD_CONTEXT_UNAVAILABLE");
    }
    let (status, sibling) = send(
        &f,
        cid,
        json!({"content":"Sibling","clientId":"thread-sibling",
        "threadRootId":"root-a","replyToMessageId":reply["id"]}),
    )
    .await;
    assert_eq!(status, 202, "{sibling}");
    assert_eq!(sibling["message"]["replyTo"]["id"], reply["id"]);
    f.close().await;
}

#[tokio::test]
async fn pi_runs_and_transcripts_are_scoped_to_the_thread() {
    let f = Fixture::new().await;
    let model = Model::new(&f).await;
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    seed(&f, cid, "root-a", "Thread anchor content").await;
    let main = submit(&f, cid, "Unrelated main task", "followUp", false).await;
    model.wait().await;
    let (status, reply) = send(&f, cid, json!({
        "content":"Thread-only instruction","clientId":"pi-thread-first","mode":"steer","threadRootId":"root-a"
    })).await;
    assert_eq!(status, 202, "{reply}");
    let input = &reply["message"];
    assert!(input["delivery"]["runId"].is_null());
    assert_eq!(input["delivery"]["state"], "queued");
    let (status, _) = f
        .request(
            "POST",
            &f.path(&format!("/conversations/{cid}/stop?threadRootId=root-a")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 409);
    model.release.add_permits(1);
    let settled = wait(&f, |snapshot| {
        snapshot["runningRequests"] == json!([])
            && snapshot["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["role"] == "assistant"
                        && message["threadRootId"] == "root-a"
                        && message["status"] == "done"
                })
    })
    .await;
    let messages = settled["messages"].as_array().unwrap();
    let saved = messages
        .iter()
        .find(|message| message["id"] == input["id"])
        .unwrap();
    assert_eq!(saved["delivery"]["state"], "delivered");
    assert_ne!(saved["delivery"]["runId"], main["delivery"]["runId"]);
    let answer = messages
        .iter()
        .find(|message| message["content"] == "Synthetic response 2")
        .unwrap();
    assert_eq!(answer["threadRootId"], "root-a");
    assert_eq!(answer["metadata"]["inputMessageId"], input["id"]);
    submit(&f, cid, "Return to main", "followUp", false).await;
    wait(&f, |snapshot| snapshot["runningRequests"] == json!([])).await;
    let calls = model.calls.lock().await;
    assert_eq!(calls.len(), 3);
    let main_prompt = calls[0].to_string();
    let thread_prompt = calls[1].to_string();
    let resumed_prompt = calls[2].to_string();
    assert!(!main_prompt.contains("Thread-only instruction"));
    assert!(thread_prompt.contains("Thread anchor content"));
    assert!(thread_prompt.contains("Thread-only instruction"));
    assert!(!thread_prompt.contains("Unrelated main task"));
    assert!(!resumed_prompt.contains("Thread-only instruction"));
    assert!(!resumed_prompt.contains("Synthetic response 2"));
    drop(calls);
    drop(model);
    f.close().await;
}
