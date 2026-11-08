mod agent_delegation_support;
mod workspace_support;
use agent_delegation_support::*;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn last_tool(body: &Value) -> Value {
    let message = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
}
fn node(group: &mut Group) {
    if let Some(node) = std::env::var_os("OPENBOT_NODE") {
        Arc::make_mut(&mut group.f.state.config).node_binary = node.into();
    }
}

#[tokio::test]
async fn final_file_delivery_is_a_real_card_and_keeps_its_bytes_after_source_edit() {
    let mut group = Group::new().await;
    node(&mut group);
    let count = Arc::new(AtomicUsize::new(0));
    let receipt = Arc::new(Mutex::new(Value::Null));
    let step = count.clone();
    let accepted = receipt.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = step.clone();
        let accepted = accepted.clone();
        Box::pin(async move {
            match step.fetch_add(1, Ordering::SeqCst) {
                0 => call(
                    "workspace_write",
                    json!({"path":"report.html","content":"<h1>FINAL_SYNTHETIC_REPORT</h1>"}),
                ),
                1 => call(
                    "workspace_deliver",
                    json!({"path":"report.html","expectedSha256":last_tool(&body)["sha256"]}),
                ),
                2 => {
                    let result = last_tool(&body);
                    assert_eq!(result["delivered"], true);
                    *accepted.lock().unwrap() = result.clone();
                    call(
                        "workspace_deliver",
                        json!({"path":"report.html","expectedSha256":result["sha256"]}),
                    )
                }
                3 => {
                    assert_eq!(
                        last_tool(&body),
                        *accepted.lock().unwrap(),
                        "Same run/version must reuse its actual receipt"
                    );
                    call(
                        "workspace_write",
                        json!({"path":"report.html","content":"SOURCE_CHANGED_AFTER_DELIVERY"}),
                    )
                }
                4 => finish("The final report was delivered as a file."),
                _ => panic!("Unexpected model request"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Create and deliver a synthetic report, then edit only the source.",
            "followUp",
            false,
        )
        .await;
    let messages = group.done().await;
    let files: Vec<_> = messages
        .iter()
        .filter(|message| message["role"] == "assistant" && message["kind"] == "file")
        .collect();
    assert_eq!(
        files.len(),
        1,
        "Repeated delivery must not create duplicate cards"
    );
    let receipt = receipt.lock().unwrap().clone();
    assert_eq!(files[0]["metadata"]["fileId"], receipt["fileId"]);
    assert_eq!(files[0]["metadata"]["name"], "report.html");
    let id = receipt["fileId"].as_str().unwrap();
    let response = group
        .f
        .request(
            "GET",
            &group.f.path(&format!("/files/{id}/download")),
            None,
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(response.0, 200, "{}", response.1);
    assert_eq!(response.1["invalid"], "<h1>FINAL_SYNTHETIC_REPORT</h1>");
    let records = group.store.list(Table::Files).await.unwrap();
    assert_eq!(records.len(), 2);
    let original = records
        .iter()
        .find(|file| file["name"] == "report.html")
        .unwrap();
    assert_ne!(original["id"], receipt["fileId"]);
    let foreign = format!("/api/workspaces/{}/files/{id}/download", group.f.foreign);
    assert_ne!(
        group
            .f
            .request("GET", &foreign, None, false, Some(&group.f.owner))
            .await
            .0,
        200
    );
    assert_eq!(count.load(Ordering::SeqCst), 5);
    drop(model);
    group.close().await;
}

#[tokio::test]
async fn unregistered_files_stale_versions_and_traversal_never_produce_delivery_cards() {
    let mut group = Group::new().await;
    node(&mut group);
    std::fs::create_dir_all(group.store.directory.join("workspace")).unwrap();
    std::fs::write(
        group.store.directory.join("workspace/unregistered.txt"),
        "UNREGISTERED",
    )
    .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let step = count.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = step.clone();
        Box::pin(async move {
            match step.fetch_add(1, Ordering::SeqCst) {
                0 => call("workspace_deliver", json!({"path":"unregistered.txt","expectedSha256":hex::encode(Sha256::digest(b"UNREGISTERED"))})),
                1 => {
                    assert!(body.to_string().contains("文件不存在"));
                    call("workspace_write", json!({"path":"draft.txt","content":"SYNTHETIC_DRAFT"}))
                }
                2 => call("workspace_deliver", json!({"path":"draft.txt","expectedSha256":"0".repeat(64)})),
                3 => {
                    assert!(body.to_string().contains("文件版本已变化"));
                    call("workspace_deliver", json!({"path":"../outside.txt","expectedSha256":"0".repeat(64)}))
                }
                4 => finish("Invalid deliveries were refused."),
                _ => panic!("Unexpected model request"),
            }
        })
    })).await;
    group.configure(&model).await;
    group
        .send(
            "Exercise only the synthetic delivery rejection fixtures.",
            "followUp",
            false,
        )
        .await;
    let messages = group.done().await;
    assert!(
        !messages
            .iter()
            .any(|message| message["role"] == "assistant" && message["kind"] == "file")
    );
    assert_eq!(group.store.list(Table::Files).await.unwrap().len(), 1);
    assert_eq!(count.load(Ordering::SeqCst), 5);
    drop(model);
    group.close().await;
}
