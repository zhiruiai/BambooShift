mod agent_delegation_support;
mod workspace_support;
use agent_delegation_support::*;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Mutex;

async fn group() -> Group {
    let mut group = Group::new().await;
    if let Some(node) = std::env::var_os("OPENBOT_NODE") {
        Arc::make_mut(&mut group.f.state.config).node_binary = node.into();
    }
    std::fs::create_dir_all(group.store.directory.join("workspace")).unwrap();
    group
}

async fn seed(group: &Group, id: &str, name: &str, bytes: &[u8], memo: bool) -> Value {
    std::fs::write(group.store.directory.join("workspace").join(name), bytes).unwrap();
    let mut record = json!({"id":id,"name":name,"size":bytes.len(),
        "type":if memo {"audio/wav"} else {"text/plain"},"conversationId":group.cid});
    if memo {
        record["source"] = json!({"kind":"voice_memo"});
    }
    group.store.put(Table::Files, &record).await.unwrap();
    record
}

async fn write_with_real_pi(group: &Group, path: &str, content: &str) -> String {
    let args = json!({"path":path,"content":content});
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::new(Mutex::new(None));
    let (step, receipt) = (calls.clone(), observed.clone());
    let model = Model::new(Arc::new(move |body| {
        let (step, receipt, args) = (step.clone(), receipt.clone(), args.clone());
        Box::pin(async move {
            match step.fetch_add(1, Ordering::SeqCst) {
                0 => call("workspace_write", args),
                1 => {
                    *receipt.lock().await = Some(
                        body["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .rev()
                            .find(|message| message["role"] == "tool")
                            .unwrap()["content"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    );
                    finish("Synthetic file registry probe completed.")
                }
                _ => panic!("Unexpected synthetic model request"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Run only the synthetic file registry check.",
            "followUp",
            false,
        )
        .await;
    let messages = group.done().await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(
        messages
            .iter()
            .any(|message| message["content"] == "Synthetic file registry probe completed.")
    );
    let result = observed.lock().await.take().unwrap();
    drop(model);
    result
}

fn alias_exists(group: &Group, name: &str) -> bool {
    group.store.directory.join("workspace").join(name).exists()
}

#[tokio::test]
async fn actual_pi_cannot_overwrite_an_immutable_memo_through_a_filesystem_alias() {
    let group = group().await;
    let original = seed(
        &group,
        "memo-id",
        "report.wav",
        b"SYNTHETIC IMMUTABLE AUDIO",
        true,
    )
    .await;
    let mut names = vec!["report.wav"];
    if alias_exists(&group, "Report.wav") {
        names.push("Report.wav");
    }
    for name in names {
        let result = write_with_real_pi(&group, name, "MUST NOT CHANGE AUDIO").await;
        assert!(result.contains("原始音频"), "{result}");
        assert_eq!(
            std::fs::read(group.store.directory.join("workspace/report.wav")).unwrap(),
            b"SYNTHETIC IMMUTABLE AUDIO"
        );
        assert_eq!(
            group.store.list(Table::Files).await.unwrap(),
            vec![original.clone()]
        );
    }
    group.close().await;
}

#[tokio::test]
async fn actual_pi_reuses_alias_registration_but_keeps_case_sensitive_objects_independent() {
    let group = group().await;
    let original = seed(&group, "lower-id", "notes.txt", b"LOWER ORIGINAL", false).await;
    let aliases = alias_exists(&group, "Notes.txt");
    let expected = if aliases {
        original.clone()
    } else {
        seed(&group, "upper-id", "Notes.txt", b"UPPER ORIGINAL", false).await
    };
    let result: Value =
        serde_json::from_str(&write_with_real_pi(&group, "Notes.txt", "UPDATED").await).unwrap();
    assert_eq!(result["fileId"], expected["id"]);
    assert_eq!(result["saved"], expected["name"]);
    let files = group.store.list(Table::Files).await.unwrap();
    assert_eq!(files.len(), if aliases { 1 } else { 2 });
    assert_eq!(
        std::fs::read(group.store.directory.join("workspace/Notes.txt")).unwrap(),
        b"UPDATED"
    );
    if aliases {
        let entry = std::fs::read_dir(group.store.directory.join("workspace"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(entry.file_name(), "notes.txt");
    } else {
        assert_eq!(
            std::fs::read(group.store.directory.join("workspace/notes.txt")).unwrap(),
            b"LOWER ORIGINAL"
        );
        assert!(files.contains(&original));
    }
    group.close().await;
}

#[tokio::test]
async fn actual_pi_refuses_old_duplicate_records_without_changing_either_record_or_bytes() {
    let group = group().await;
    seed(&group, "first-id", "notes.txt", b"ORIGINAL", false).await;
    let alias = if alias_exists(&group, "Notes.txt") {
        "Notes.txt"
    } else {
        "notes.txt"
    };
    group
        .store
        .put(
            Table::Files,
            &json!({"id":"second-id","name":alias,"size":8,"type":"text/plain"}),
        )
        .await
        .unwrap();
    let before = group.store.list(Table::Files).await.unwrap();
    let result = write_with_real_pi(&group, "notes.txt", "MUST NOT BE WRITTEN").await;
    assert!(result.contains("登记存在重复记录"), "{result}");
    assert_eq!(group.store.list(Table::Files).await.unwrap(), before);
    assert_eq!(
        std::fs::read(group.store.directory.join("workspace/notes.txt")).unwrap(),
        b"ORIGINAL"
    );
    assert_eq!(
        std::fs::read_dir(group.store.directory.join("workspace"))
            .unwrap()
            .count(),
        1
    );
    group.close().await;
}

#[tokio::test]
async fn actual_pi_preserves_missing_file_registration_and_immutable_exact_name_rules() {
    let group = group().await;
    for (id, name, memo) in [
        ("memo-id", "missing.wav", true),
        ("note-id", "missing.txt", false),
    ] {
        let record = seed(&group, id, name, b"ORIGINAL", memo).await;
        std::fs::remove_file(group.store.directory.join("workspace").join(name)).unwrap();
        let result = write_with_real_pi(&group, name, "RECREATED").await;
        if memo {
            assert!(result.contains("原始音频"), "{result}");
            assert!(!alias_exists(&group, name));
            assert_eq!(
                group.store.get(Table::Files, id).await.unwrap().unwrap(),
                record
            );
        } else {
            let result: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(result["fileId"], id);
            assert_eq!(
                std::fs::read(group.store.directory.join("workspace").join(name)).unwrap(),
                b"RECREATED"
            );
        }
    }
    assert_eq!(group.store.list(Table::Files).await.unwrap().len(), 2);
    group.close().await;
}

#[tokio::test]
async fn actual_pi_does_not_recreate_a_missing_registered_file_through_a_spelling_alias() {
    let group = group().await;
    for (id, name, alias, memo) in [
        ("memo-id", "missing.wav", "Missing.wav", true),
        ("note-id", "missing.txt", "Missing.txt", false),
    ] {
        let record = seed(&group, id, name, b"ORIGINAL", memo).await;
        // Detect this directory's actual behavior while the original still
        // exists; do not infer case sensitivity from the operating system.
        let aliases = alias_exists(&group, alias);
        std::fs::remove_file(group.store.directory.join("workspace").join(name)).unwrap();
        let before = group.store.list(Table::Files).await.unwrap();
        let result = write_with_real_pi(&group, alias, "ALIAS MUST NOT RECREATE ORIGINAL").await;
        if aliases {
            let receipt = serde_json::from_str::<Value>(&result).unwrap_or(Value::Null);
            assert!(receipt["fileId"].is_null(), "{result}");
            assert!(!alias_exists(&group, name));
            assert!(!alias_exists(&group, alias));
            assert_eq!(group.store.list(Table::Files).await.unwrap(), before);
        } else {
            // On a case-sensitive volume this is a genuinely separate file,
            // so the missing original must not prevent its independent use.
            let receipt: Value = serde_json::from_str(&result).unwrap();
            assert_ne!(receipt["fileId"], id);
            assert_eq!(receipt["saved"], alias);
            assert!(!alias_exists(&group, name));
            assert_eq!(
                std::fs::read(group.store.directory.join("workspace").join(alias)).unwrap(),
                b"ALIAS MUST NOT RECREATE ORIGINAL"
            );
            assert_eq!(
                group.store.list(Table::Files).await.unwrap().len(),
                before.len() + 1
            );
        }
        assert_eq!(
            group.store.get(Table::Files, id).await.unwrap().unwrap(),
            record
        );

        // The failed alias operation must not break exact-name recovery of an
        // ordinary missing file or weaken the immutable memo's original rule.
        let exact = write_with_real_pi(&group, name, "EXACT NAME RECOVERY").await;
        if memo {
            assert!(exact.contains("原始音频"), "{exact}");
            assert!(!alias_exists(&group, name));
            assert_eq!(
                group.store.get(Table::Files, id).await.unwrap().unwrap(),
                record
            );
        } else {
            let receipt: Value = serde_json::from_str(&exact).unwrap();
            assert_eq!(receipt["fileId"], id);
            assert_eq!(receipt["saved"], name);
            assert_eq!(
                std::fs::read(group.store.directory.join("workspace").join(name)).unwrap(),
                b"EXACT NAME RECOVERY"
            );
        }
    }
    group.close().await;
}
