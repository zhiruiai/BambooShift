use openbot_backend::workspace::{Table, WorkspaceRegistry};
use serde_json::json;
#[tokio::test]
async fn startup_interrupts_uncertain_work_once_without_replaying_or_replacing_completed_results() {
    let dir = tempfile::tempdir().unwrap();
    let wid = uuid::Uuid::new_v4().to_string();
    let registry = WorkspaceRegistry::new(dir.path().to_owned());
    let store = registry.get(&wid, &wid).await.unwrap();
    let mut agent = store.list(Table::Agents).await.unwrap().remove(0);
    agent["status"] = json!("working");
    agent["name"] = json!("Latest profile");
    let revision = agent["configRevision"].clone();
    store.put(Table::Agents, &agent).await.unwrap();
    let messages = vec![
        json!({"id":"queued","role":"user","content":"Queued request","delivery":{"state":"queued","clientId":"stable-request"}}),
        json!({"id":"input","role":"user","content":"In progress","delivery":{"state":"delivered"}}),
        json!({"id":"running","role":"assistant","status":"running","content":"Partial verified text","metadata":{"inputMessageId":"input"}}),
        json!({"id":"done","role":"assistant","status":"done","content":"Previously completed"}),
        json!({"id":"approval","role":"assistant","kind":"approval","status":"done","content":"Pending action","metadata":{"appAction":{"id":"action","status":"pending"}}}),
    ];
    for message in &messages {
        store.put(Table::Messages, message).await.unwrap();
    }
    for table in ["routine_runs", "routine_operations", "primary_check_ins"] {
        let insert = match table {
            "routine_runs" => {
                "INSERT INTO routine_runs(run_id,routine_id,started_at,data) VALUES('old','old','2026-01-01T00:00:00.000Z',?)"
            }
            "routine_operations" => {
                "INSERT INTO routine_operations(actor_id,request_id,digest,data) VALUES('fixture-actor','old','fixture-digest',?)"
            }
            _ => {
                "INSERT INTO primary_check_ins(id,day,revision,data) VALUES('old','2026-01-01','fixture-revision',?)"
            }
        };
        sqlx::query(insert).bind(json!({"status":if table=="routine_operations"{"submitted"}else{"running"},"kind":"run","id":"old"}).to_string()).execute(&store.pool).await.unwrap();
    }
    registry.close().await;
    let restarted = WorkspaceRegistry::new(dir.path().to_owned());
    let next = restarted.get(&wid, &wid).await.unwrap();
    assert_eq!(
        next.list(Table::Messages).await.unwrap().len(),
        messages.len()
    );
    assert_eq!(
        next.get(Table::Messages, "queued").await.unwrap().unwrap()["delivery"]["state"],
        "interrupted"
    );
    assert_eq!(
        next.get(Table::Messages, "input").await.unwrap().unwrap()["delivery"]["state"],
        "interrupted"
    );
    let result = next.get(Table::Messages, "running").await.unwrap().unwrap();
    assert_eq!(result["status"], "error");
    assert!(
        result["content"]
            .as_str()
            .unwrap()
            .starts_with("Partial verified text")
    );
    assert!(result["content"].as_str().unwrap().contains("未确认完成"));
    assert_eq!(
        next.get(Table::Messages, "done").await.unwrap().unwrap(),
        messages[3]
    );
    assert_eq!(
        next.get(Table::Messages, "approval")
            .await
            .unwrap()
            .unwrap()["metadata"]["appAction"]["status"],
        "cancelled"
    );
    let updated = next
        .get(Table::Agents, agent["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated["status"], "idle");
    assert_eq!(updated["name"], "Latest profile");
    assert_eq!(updated["configRevision"], revision);
    for table in ["routine_runs", "routine_operations", "primary_check_ins"] {
        let data: String = sqlx::query_scalar(&format!("SELECT data FROM {table}"))
            .fetch_one(&next.pool)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&data).unwrap()["status"],
            "interrupted"
        );
    }
    restarted.close().await;
    let again = WorkspaceRegistry::new(dir.path().to_owned());
    let stable = again.get(&wid, &wid).await.unwrap();
    assert_eq!(
        stable
            .get(Table::Messages, "running")
            .await
            .unwrap()
            .unwrap(),
        result
    );
    stable
        .put(
            Table::Messages,
            &json!({"id":"new-active","status":"running","content":"Current process"}),
        )
        .await
        .unwrap();
    let cached = again.get(&wid, &wid).await.unwrap();
    assert_eq!(
        cached
            .get(Table::Messages, "new-active")
            .await
            .unwrap()
            .unwrap()["status"],
        "running"
    );
    again.close().await;
}
