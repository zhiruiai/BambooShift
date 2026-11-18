use super::*;
use crate::workspace::{Table, WorkspaceStore};
use sqlx::Connection;

async fn memory() -> SqliteConnection {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    for table in ["messages", "conversations"] {
        sqlx::query(&format!(
            "CREATE TABLE {table}(id TEXT PRIMARY KEY,data TEXT NOT NULL)"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
    }
    conn
}
async fn put(conn: &mut SqliteConnection, message: Value) {
    WorkspaceStore::put_in(conn, Table::Messages, &message)
        .await
        .unwrap();
}
fn message(id: &str, status: &str) -> Value {
    json!({"id":id,"conversationId":"chat-a","role":"assistant","kind":"text","status":status,"content":"Synthetic result","createdAt":"2026-11-07T00:00:00Z"})
}
async fn view(conn: &mut SqliteConnection, actor: &str) -> Value {
    let mut chats = vec![json!({"id":"chat-a"})];
    project(conn, actor, &mut chats).await.unwrap();
    chats.remove(0)
}
#[tokio::test]
async fn first_terminal_delivery_counts_once_without_timestamp_or_stream_ties() {
    let mut conn = memory().await;
    initialize(&mut conn).await.unwrap();
    put(&mut conn, message("a", "running")).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 0);
    put(&mut conn, message("a", "done")).await;
    let first = view(&mut conn, "alice").await;
    for _ in 0..4 {
        put(&mut conn, message("a", "done")).await;
    }
    assert_eq!(view(&mut conn, "alice").await, first);
    put(&mut conn, message("b", "done")).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 2);
    assert!(
        view(&mut conn, "alice").await["readThrough"]
            .as_u64()
            .unwrap()
            > first["readThrough"].as_u64().unwrap()
    );
}
#[tokio::test]
async fn actors_acknowledge_only_observed_deliveries_and_never_clear_each_other() {
    let mut conn = memory().await;
    initialize(&mut conn).await.unwrap();
    put(&mut conn, message("a", "done")).await;
    let first = view(&mut conn, "alice").await["readThrough"].clone();
    put(&mut conn, message("b", "done")).await;
    assert!(
        acknowledge(&mut conn, "alice", "chat-a", Some(&first))
            .await
            .unwrap()
    );
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
    assert_eq!(view(&mut conn, "bob").await["unread"], 2);
    assert!(
        !acknowledge(&mut conn, "alice", "chat-a", Some(&first))
            .await
            .unwrap()
    );
    assert!(
        acknowledge(&mut conn, "alice", "chat-a", Some(&json!(10000)))
            .await
            .is_err()
    );
    acknowledge(&mut conn, "bob", "chat-a", None).await.unwrap();
    assert_eq!(view(&mut conn, "bob").await["unread"], 0);
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
}
#[tokio::test]
async fn user_system_private_incomplete_and_deleted_messages_are_not_unread() {
    let mut conn = memory().await;
    initialize(&mut conn).await.unwrap();
    for (id, role, status, metadata) in [
        ("user", "user", "done", json!({})),
        ("system", "system", "done", json!({})),
        (
            "private",
            "assistant",
            "done",
            json!({"delegation":{"runId":"private"}}),
        ),
        ("internal", "assistant", "done", json!({"internal":true})),
        ("stream", "assistant", "running", json!({})),
    ] {
        let mut value = message(id, status);
        value["role"] = json!(role);
        value["metadata"] = metadata;
        put(&mut conn, value).await;
    }
    assert_eq!(view(&mut conn, "alice").await["unread"], 0);
    let mut failed = message("failed", "error");
    failed["metadata"] = json!({"executionStatus":"interrupted"});
    put(&mut conn, failed).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
    acknowledge(&mut conn, "alice", "chat-a", None)
        .await
        .unwrap();
    let mut template = message("template", "done");
    template["metadata"] = json!({"botTemplate":{"templateId":"t"}});
    put(&mut conn, template).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
    WorkspaceStore::delete_in(&mut conn, Table::Messages, "template")
        .await
        .unwrap();
    assert_eq!(view(&mut conn, "alice").await["unread"], 0);
    put(&mut conn, message("template", "done")).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
    put(&mut conn, message("template", "running")).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 0);
    put(&mut conn, message("template", "done")).await;
    assert_eq!(view(&mut conn, "alice").await["readThrough"], 2);
}
#[tokio::test]
async fn migration_baselines_old_history_preserves_legacy_count_and_survives_reinitialize() {
    let mut conn = memory().await;
    WorkspaceStore::put_in(
        &mut conn,
        Table::Conversations,
        &json!({"id":"chat-a","unread":1}),
    )
    .await
    .unwrap();
    for id in ["old-a", "old-b", "old-template"] {
        put(&mut conn, message(id, "done")).await;
    }
    initialize(&mut conn).await.unwrap();
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
    acknowledge(&mut conn, "alice", "chat-a", None)
        .await
        .unwrap();
    initialize(&mut conn).await.unwrap();
    assert_eq!(view(&mut conn, "alice").await["unread"], 0);
    assert_eq!(view(&mut conn, "bob").await["unread"], 1);
    put(&mut conn, message("new-a", "done")).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
    assert_eq!(view(&mut conn, "bob").await["unread"], 2);
    WorkspaceStore::delete_in(&mut conn, Table::Conversations, "chat-a")
        .await
        .unwrap();
    assert_eq!(view(&mut conn, "alice").await["unread"], 0);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM conversation_reads")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}
#[tokio::test]
async fn delivery_sequences_and_actor_cursors_survive_a_real_store_restart() {
    let directory = tempfile::tempdir().unwrap();
    let store = WorkspaceStore::open(directory.path()).await.unwrap();
    store
        .put(Table::Conversations, &json!({"id":"chat-a","unread":0}))
        .await
        .unwrap();
    store
        .put(Table::Messages, &message("persisted", "done"))
        .await
        .unwrap();
    {
        let mut conn = store.pool.acquire().await.unwrap();
        let through = view(&mut conn, "alice").await["readThrough"].clone();
        acknowledge(&mut conn, "alice", "chat-a", Some(&through))
            .await
            .unwrap();
    }
    store.close().await;
    drop(store);
    let reopened = WorkspaceStore::open(directory.path()).await.unwrap();
    {
        let mut conn = reopened.pool.acquire().await.unwrap();
        assert_eq!(view(&mut conn, "alice").await["unread"], 0);
        assert_eq!(view(&mut conn, "bob").await["unread"], 1);
        put(&mut conn, message("persisted", "error")).await;
        assert_eq!(view(&mut conn, "bob").await["unread"], 1);
        put(&mut conn, message("new-after-restart", "error")).await;
        assert_eq!(view(&mut conn, "alice").await["unread"], 1);
    }
    reopened.close().await;
}

#[tokio::test]
async fn research_receipts_refresh_legacy_triggers_without_advancing_delivery() {
    let mut conn = memory().await;
    initialize(&mut conn).await.unwrap();
    sqlx::query("DROP TRIGGER unread_message_insert")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER unread_message_insert AFTER INSERT ON messages WHEN json_extract(NEW.data,'$.role')='assistant' BEGIN INSERT INTO unread_deliveries(message_id,conversation_id) VALUES(NEW.id,json_extract(NEW.data,'$.conversationId')); END")
        .execute(&mut conn).await.unwrap();
    initialize(&mut conn).await.unwrap();
    let mut receipt = message("research", "done");
    receipt["kind"] = json!("web_research");
    receipt["content"] = json!("");
    put(&mut conn, receipt.clone()).await;
    put(&mut conn, receipt).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 0);
    assert_eq!(view(&mut conn, "alice").await["readThrough"], 0);
    put(&mut conn, message("answer", "done")).await;
    assert_eq!(view(&mut conn, "alice").await["unread"], 1);
}
