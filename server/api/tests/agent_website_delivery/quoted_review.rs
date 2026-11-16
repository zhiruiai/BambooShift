use super::{ENTRY, Group, Model, UPDATED, call, finish, hash, tool_output, tool_result};
use crate::agent_delegation_support::{has_tool_result, wait_gate};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;

const READ: &str = "workspace_read_website_version";

pub(super) async fn verify(group: &Group, old: &Value, manifest: &Value, current: &Value) {
    let steps = Arc::new(AtomicUsize::new(0));
    let quoted_model = Model::new(Arc::new({
        let manifest = manifest.clone();
        let steps = steps.clone();
        let current_id = current["id"].clone();
        move |body| {
            let manifest = manifest.clone();
            let current_id = current_id.clone();
            let step = steps.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                match step {
                    0 => call(READ, json!({})),
                    1 => {
                        assert_eq!(tool_result(&body), manifest);
                        call(READ, json!({"path":"index.html"}))
                    }
                    2 => {
                        let source = tool_result(&body);
                        assert_eq!(source["versionId"], manifest["id"]);
                        assert_eq!(source["text"], ENTRY);
                        assert_eq!(source["file"]["sha256"], hash(ENTRY));
                        assert!(source["nextOffset"].is_null());
                        call(READ, json!({"path":"index.html","versionId":current_id}))
                    }
                    3 => {
                        let output = tool_output(&body);
                        assert!(serde_json::from_str::<Value>(output).is_err());
                        assert!(!output.contains(ENTRY) && !output.contains(UPDATED));
                        finish("I read the exact quoted website delivery.")
                    }
                    _ => panic!("Unexpected quoted website read"),
                }
            })
        }
    }))
    .await;
    group.configure(&quoted_model).await;
    let delivery = old["id"].as_str().unwrap();
    submit(group, delivery, "Review the version I quoted.", "followUp").await;
    assert!(group.done().await.iter().any(|message| {
        message["status"] == "done"
            && message["content"] == "I read the exact quoted website delivery."
    }));
    assert_eq!(steps.load(Ordering::SeqCst), 4);
    let calls = quoted_model.calls.lock().await;
    let user = calls[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user")
        .unwrap();
    let content = user["content"]
        .as_str()
        .or_else(|| user["content"][0]["text"].as_str())
        .unwrap();
    let prompt: Value = serde_json::from_str(content).unwrap();
    assert_eq!(
        prompt["replyContext"]["websiteProject"],
        json!({
            "id":manifest["id"],"projectKey":manifest["projectKey"],"title":"Synthetic website",
            "entry":"index.html","directory":"synthetic-site"
        })
    );
    assert_eq!(prompt["websiteProjects"].as_array().unwrap().len(), 1);
    assert_eq!(prompt["websiteProjects"][0]["id"], current["id"]);
    drop(calls);

    steer_to_old_version(group, delivery).await;
    assert_eq!(
        std::fs::read(
            group
                .store
                .directory
                .join("workspace/synthetic-site/index.html")
        )
        .unwrap(),
        UPDATED.as_bytes()
    );
}

async fn steer_to_old_version(group: &Group, delivery: &str) {
    let entered = Arc::new(Semaphore::new(0));
    let released = Arc::new(Semaphore::new(0));
    let instruction = "Use the exact historical delivery I am quoting.";
    let model = Model::new(Arc::new({
        let entered = entered.clone();
        let released = released.clone();
        move |body| {
            let entered = entered.clone();
            let released = released.clone();
            Box::pin(async move {
                if !body.to_string().contains(instruction) {
                    entered.add_permits(1);
                    released.acquire().await.unwrap().forget();
                } else if has_tool_result(&body)
                    && serde_json::from_str::<Value>(tool_output(&body))
                        .ok()
                        .is_some_and(|result| result["text"] == ENTRY)
                {
                    return finish("I read the historical bytes requested in this turn.");
                }
                call(READ, json!({"path":"index.html"}))
            })
        }
    }))
    .await;
    group.configure(&model).await;
    let initial = group
        .send(
            "Begin a response without quoting a website.",
            "followUp",
            false,
        )
        .await;
    wait_gate(&entered).await;
    let steered = submit(group, delivery, instruction, "steer").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    released.add_permits(1);
    assert!(group.done().await.iter().any(|message| {
        message["status"] == "done"
            && message["content"] == "I read the historical bytes requested in this turn."
    }));
    let old_run = initial["delivery"]["runId"].as_str().unwrap();
    let updated = group
        .store
        .get(Table::Messages, steered["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated["delivery"]["runId"], old_run);
}

async fn submit(group: &Group, delivery: &str, content: &str, mode: &str) -> Value {
    let (status, body) = group.f.request(
        "POST", &group.f.path(&format!("/conversations/{}/messages", group.cid)),
        Some(json!({"content":content,"clientId":uuid::Uuid::new_v4().to_string(),"agentId":group.ids[0],"replyToMessageId":delivery,"mode":mode})),
        false, Some(&group.f.owner),
    ).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["message"]["replyTo"]["id"], delivery);
    body["message"].clone()
}
