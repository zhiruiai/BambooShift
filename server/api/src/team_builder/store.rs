use crate::{
    db::{iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    for query in [
        "CREATE TABLE IF NOT EXISTS bot_team_plans(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,commit_request_id TEXT UNIQUE,data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS bot_team_proposals(root_run_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE)",
        "CREATE TABLE IF NOT EXISTS bot_team_catalog_keys(id TEXT PRIMARY KEY,value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS bot_team_catalog_refreshes(request_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,digest TEXT NOT NULL,applied_revision TEXT NOT NULL)",
    ] {
        sqlx::query(query).execute(&mut *conn).await?;
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    sqlx::query("INSERT OR IGNORE INTO bot_team_catalog_keys(id,value) VALUES('review',?)")
        .bind(hex::encode(key))
        .execute(&mut *conn)
        .await?;
    let rows = sqlx::query("SELECT data FROM bot_team_plans")
        .fetch_all(&mut *conn)
        .await?;
    for row in rows {
        let mut saved = decode(row.get("data"))?;
        if saved["plan"]["status"] == "generating" {
            saved["plan"]["status"] = json!("error");
            saved["plan"]["error"] =
                json!("服务已重新启动，方案生成已中断。目标已保留，请重新生成。");
            stamp(&mut saved);
            save(conn, &saved).await?;
        }
    }
    Ok(())
}
pub fn decode(data: String) -> Result<Value> {
    let v: Value =
        serde_json::from_str(&data).map_err(|_| ApiError::new(409, "团队方案记录不可用。"))?;
    if !v["plan"].is_object() || !v["catalog"].is_object() {
        return Err(ApiError::new(409, "团队方案记录不可用。"));
    }
    Ok(v)
}
pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Value> {
    super::draft::uuid(&json!(id))?;
    let row: Option<String> = sqlx::query_scalar("SELECT data FROM bot_team_plans WHERE id=?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    decode(row.ok_or_else(|| ApiError::new(404, "团队方案不存在。"))?)
}
pub fn stamp(saved: &mut Value) {
    saved["plan"]["revision"] = json!(uuid::Uuid::new_v4().to_string());
    saved["plan"]["updatedAt"] = json!(iso(now()));
}
pub async fn save(conn: &mut SqliteConnection, saved: &Value) -> Result<Option<Value>> {
    sqlx::query("INSERT INTO bot_team_plans(id,request_id,commit_request_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET commit_request_id=excluded.commit_request_id,data=excluded.data")
        .bind(saved["plan"]["id"].as_str()).bind(saved["plan"]["requestId"].as_str()).bind(saved["commit"]["requestId"].as_str()).bind(saved.to_string()).execute(&mut *conn).await?;
    card(conn, saved).await
}
pub async fn source(conn: &mut SqliteConnection, saved: &Value) -> Result<()> {
    let Some(source) = saved["plan"].get("source") else {
        return Ok(());
    };
    let chat = WorkspaceStore::get_in(
        conn,
        Table::Conversations,
        source["conversationId"].as_str().unwrap_or(""),
    )
    .await?;
    let input = WorkspaceStore::get_in(
        conn,
        Table::Messages,
        saved["proposal"]["inputMessageId"].as_str().unwrap_or(""),
    )
    .await?;
    let agent = WorkspaceStore::get_in(
        conn,
        Table::Agents,
        source["agentId"].as_str().unwrap_or(""),
    )
    .await?;
    if !chat.is_some_and(|c| {
        c["agentIds"]
            .as_array()
            .is_some_and(|ids| ids.contains(&source["agentId"]))
    }) || !input.is_some_and(|m| {
        m["role"] == "user"
            && m["conversationId"] == source["conversationId"]
            && m["userId"] == source["userId"]
    }) || agent.is_none()
    {
        return Err(ApiError::new(
            409,
            "方案来源已移除，请在当前聊天重新提出方案。",
        ));
    }
    Ok(())
}
pub async fn card(conn: &mut SqliteConnection, saved: &Value) -> Result<Option<Value>> {
    let plan = &saved["plan"];
    let Some(source) = plan.get("source") else {
        return Ok(None);
    };
    let Some(mut message) = WorkspaceStore::get_in(
        conn,
        Table::Messages,
        source["messageId"].as_str().unwrap_or(""),
    )
    .await?
    else {
        return Ok(None);
    };
    if message["conversationId"] != source["conversationId"]
        || message["agentId"] != source["agentId"]
    {
        return Err(ApiError::new(409, "方案聊天记录已变化。"));
    }
    let Some(members) = plan["draft"]["members"].as_array() else {
        return Ok(None);
    };
    let mut rows = Vec::new();
    for member in members {
        let profile = if member["kind"] == "create" {
            member.clone()
        } else {
            WorkspaceStore::get_in(
                conn,
                Table::Agents,
                member["agentId"].as_str().unwrap_or(""),
            )
            .await?
            .or_else(|| {
                saved["proposal"]["agents"]
                    .as_array()
                    .and_then(|v| v.iter().find(|a| a["id"] == member["agentId"]).cloned())
            })
            .unwrap_or(json!({"name":"已移除的 Bot","role":""}))
        };
        let mut row = json!({"key":member["key"],"kind":member["kind"],"name":profile["name"],"role":profile["role"],"assignment":member["assignment"]});
        if member["kind"] == "reuse" {
            row["agentId"] = member["agentId"].clone();
        }
        rows.push(row);
    }
    let mut card = json!({"planId":plan["id"],"revision":plan["revision"],"status":plan["status"],"goal":plan["goal"],"title":plan["draft"]["title"],"summary":plan["draft"]["summary"],"leadKey":plan["draft"]["leadKey"],"members":rows});
    for k in ["result", "error"] {
        if let Some(v) = plan.get(k) {
            card[k] = v.clone();
        }
    }
    if !message["metadata"].is_object() {
        message["metadata"] = json!({});
    }
    message["metadata"]["teamProposal"] = card;
    message["status"] = json!("done");
    message["content"] = json!(format!(
        "{}：{}",
        if plan["status"] == "committed" {
            "已创建团队"
        } else if plan["status"] == "cancelled" {
            "已取消团队方案"
        } else {
            "团队方案"
        },
        plan["draft"]["title"].as_str().unwrap_or("")
    ));
    WorkspaceStore::put_in(conn, Table::Messages, &message).await?;
    Ok(Some(message))
}
pub fn notify(store: &WorkspaceStore, message: Option<Value>) {
    if let Some(message) = message {
        store.emit("message", message);
    }
    store.emit("update", json!({}));
}
