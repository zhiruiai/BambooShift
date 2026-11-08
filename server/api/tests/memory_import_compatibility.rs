mod memory_import_support;
mod workspace_support;
use memory_import_support::*;
use openbot_backend::{config::Config, db::State, workspace::Table};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[tokio::test]
async fn old_node_receipts_keep_proven_terminal_results_and_never_replay_unknown_work() {
    let mut f = personal().await;
    let primary = primary(&f).await;
    let store = store(&f).await;
    let mut cases = Vec::new();
    for (terminal, expected) in [
        ("done", "completed"),
        ("error", "error"),
        ("running", "interrupted"),
    ] {
        let body = request(&primary);
        let id = body["requestId"].as_str().unwrap();
        let mid = uuid::Uuid::new_v4().to_string();
        let output = uuid::Uuid::new_v4().to_string();
        let receipt = json!({"requestId":id,"primaryRevision":primary["revision"],"userId":f.owner,"workspaceId":f.workspace,"agentId":primary["agentId"],"conversationId":primary["conversationId"],"messageId":mid,"createdAt":"2026-01-01T00:00:00.000Z"});
        let source = format!(
            "{{\"expectedPrimaryRevision\":{},\"content\":{}}}",
            body["expectedPrimaryRevision"], body["content"]
        );
        sqlx::query("INSERT INTO memory_imports(actor_id,request_id,digest,data,message_id) VALUES(?,?,?,?,?)")
            .bind(format!("user:{}",f.owner)).bind(id).bind(format!("{:x}",Sha256::digest(source))).bind(receipt.to_string()).bind(&mid).execute(&store.pool).await.unwrap();
        store.put(Table::Messages,&json!({"id":mid,"role":"user","userId":f.owner,"conversationId":primary["conversationId"],"content":"Synthetic import summary","createdAt":"2026-01-01T00:00:00.000Z","delivery":{"state":"delivered","clientId":id,"agentId":primary["agentId"]},"metadata":{"memoryImport":{"id":id}}})).await.unwrap();
        store.put(Table::Messages,&json!({"id":output,"role":"assistant","agentId":primary["agentId"],"conversationId":primary["conversationId"],"content":"Synthetic historical output","createdAt":"2026-01-01T00:00:01.000Z","status":terminal,"metadata":{"memoryImport":{"requestId":id,"inputMessageId":mid}}})).await.unwrap();
        cases.push((body, expected, output));
    }
    f.state.close().await;
    f.state = State::open(Config::local(f.directory.path()))
        .await
        .unwrap();
    for (body, expected, output) in cases {
        let result = receipt(&f, body["requestId"].as_str().unwrap()).await;
        assert_eq!(result.0, 200, "{}", result.1);
        assert_eq!(result.1["status"], expected);
        if expected == "interrupted" {
            assert!(result.1.get("resultMessageId").is_none());
        } else {
            assert_eq!(result.1["resultMessageId"], output);
        }
        let replay = f
            .request(
                "POST",
                &f.path("/memory-imports"),
                Some(body),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(replay.0, 200, "{}", replay.1);
        assert_eq!(replay.1, result.1);
    }
    let current = memory_import_support::store(&f).await;
    assert_eq!(current.list(Table::Messages).await.unwrap().len(), 6);
    assert_eq!(current.list(Table::Memories).await.unwrap().len(), 0);
    f.close().await;
}

#[tokio::test]
async fn rejected_fresh_inputs_are_distinguished_from_existing_receipts_or_access_failure() {
    let f = personal().await;
    let p = primary(&f).await;
    let mut body = request(&p);
    body["content"] = json!(" ");
    let rejected = f
        .request(
            "POST",
            &f.path("/memory-imports"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(rejected.0, 400);
    assert_eq!(rejected.1["code"], "MEMORY_IMPORT_NOT_STARTED");
    let forbidden = f
        .request(
            "POST",
            &f.path("/memory-imports"),
            Some(body),
            false,
            Some(&f.member),
        )
        .await;
    assert_eq!(forbidden.0, 403);
    assert_ne!(forbidden.1["code"], "MEMORY_IMPORT_NOT_STARTED");
    let s = store(&f).await;
    let body = request(&p);
    let invalid: Value = json!({"status":"queued"});
    sqlx::query(
        "INSERT INTO memory_imports(actor_id,request_id,digest,data,message_id) VALUES(?,?,?,?,?)",
    )
    .bind(format!("user:{}", f.owner))
    .bind(body["requestId"].as_str())
    .bind("a".repeat(64))
    .bind(invalid.to_string())
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(&s.pool)
    .await
    .unwrap();
    let conflict = f
        .request(
            "POST",
            &f.path("/memory-imports"),
            Some(body),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(conflict.0, 409);
    assert_eq!(conflict.1["code"], "MEMORY_IMPORT_RECEIPT_INVALID");
    f.close().await;
}
