use crate::{
    db::{iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};

pub async fn initialize(store: &WorkspaceStore) -> Result<Vec<String>> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS computer_actions(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    )
    .execute(&store.pool)
    .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS computer_frames(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,agent_id TEXT NOT NULL,created_at TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,mime_type TEXT NOT NULL,bytes BLOB NOT NULL)").execute(&store.pool).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS computer_recovery(agent_id TEXT PRIMARY KEY)")
        .execute(&store.pool)
        .await?;
    let rows:Vec<String>=sqlx::query_scalar("SELECT data FROM computer_actions WHERE json_extract(data,'$.action.status') IN ('pending','running')").fetch_all(&store.pool).await?;
    for raw in rows {
        let mut saved: Value =
            serde_json::from_str(&raw).map_err(|_| ApiError::new(500, "电脑操作记录无效。"))?;
        if saved["action"]["status"] == "running" {
            saved["recoveryRequired"] = json!(true);
        }
        saved["action"]["error"] = json!(if saved["action"]["status"] == "running" {
            "服务已重启，原操作结果未知；请先核对电脑，不要自动重试。"
        } else {
            "服务已重启，原审批已失效。"
        });
        saved["action"]["status"] = json!(if saved["action"]["status"] == "running" {
            "error"
        } else {
            "rejected"
        });
        persist(store, &saved).await?;
    }
    let agents: Vec<String> = sqlx::query_scalar("SELECT DISTINCT COALESCE(json_extract(data,'$.recoveryScope'),json_extract(data,'$.context.agentId'),'default') FROM computer_actions WHERE json_extract(data,'$.recoveryRequired')=1 UNION SELECT agent_id FROM computer_recovery").fetch_all(&store.pool).await?;
    Ok(agents)
}
pub async fn mark_recovery(store: &WorkspaceStore, agent: &str) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO computer_recovery(agent_id) VALUES(?)")
        .bind(agent)
        .execute(&store.pool)
        .await?;
    Ok(())
}
pub async fn clear_recovery(store: &WorkspaceStore, agent: &str) -> Result<()> {
    let mut tx = store.begin().await?;
    sqlx::query("DELETE FROM computer_recovery WHERE agent_id=?")
        .bind(agent)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE computer_actions SET data=json_set(data,'$.recoveryRequired',false) WHERE COALESCE(json_extract(data,'$.recoveryScope'),json_extract(data,'$.context.agentId'),'default')=?").bind(agent).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn raw(store: &WorkspaceStore, id: &str) -> Result<Value> {
    let raw: Option<String> = sqlx::query_scalar("SELECT data FROM computer_actions WHERE id=?")
        .bind(id)
        .fetch_optional(&store.pool)
        .await?;
    serde_json::from_str(&raw.ok_or_else(|| ApiError::new(404, "未找到电脑操作。"))?)
        .map_err(|_| ApiError::new(500, "电脑操作记录无效。"))
}
pub async fn get(store: &WorkspaceStore, id: &str) -> Result<Value> {
    Ok(raw(store, id).await?["action"].clone())
}
pub async fn list(store: &WorkspaceStore, agent: Option<&str>) -> Result<Vec<Value>> {
    let rows: Vec<String> =
        sqlx::query_scalar("SELECT data FROM computer_actions ORDER BY rowid DESC LIMIT 500")
            .fetch_all(&store.pool)
            .await?;
    Ok(rows
        .iter()
        .filter_map(|row| serde_json::from_str::<Value>(row).ok())
        .map(|v| v["action"].clone())
        .filter(|a| agent.is_none_or(|id| a["agentId"] == id))
        .collect())
}
pub async fn persist(store: &WorkspaceStore, saved: &Value) -> Result<()> {
    let id = saved["id"]
        .as_str()
        .ok_or_else(|| ApiError::bad("电脑操作标识无效。"))?;
    let mut tx = store.begin().await?;
    sqlx::query("INSERT INTO computer_actions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(id).bind(saved.to_string()).execute(&mut *tx).await?;
    let mut card = None;
    if let (Some(cid), Some(card_id)) = (
        saved["context"]["conversationId"].as_str(),
        saved["cardId"].as_str(),
    ) {
        if WorkspaceStore::get_in(&mut tx, Table::Conversations, cid)
            .await?
            .is_some()
        {
            let action = &saved["action"];
            let existing = WorkspaceStore::get_in(&mut tx, Table::Messages, card_id).await?;
            let mut message=existing.unwrap_or_else(||json!({"id":card_id,"conversationId":cid,"role":"assistant","agentId":saved["context"]["agentId"],"createdAt":action["createdAt"].as_str().unwrap_or(&iso(now()))}));
            message["kind"] = json!("computer");
            message["status"] = json!(if action["status"] == "error" {
                "error"
            } else if action["status"] == "running" {
                "running"
            } else {
                "done"
            });
            message["content"] = json!(match action["status"].as_str() {
                Some("pending") => "电脑操作等待发起人批准。",
                Some("running") => "正在执行电脑操作。",
                Some("done") => "电脑操作已完成。",
                Some("rejected") => "电脑操作已取消。",
                _ => "电脑操作未能确认完成，请核对结果。",
            });
            message["metadata"] = json!({"action":action});
            crate::agent::threads::stamp(&mut message, saved["context"]["threadRootId"].as_str());
            WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
            card = Some(message);
        }
    }
    tx.commit().await?;
    if let Some(card) = card {
        store.emit("message", card);
    }
    store.emit("update", json!({}));
    Ok(())
}
