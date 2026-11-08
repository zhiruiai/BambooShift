use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

pub(crate) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    super::operation_store::initialize(conn).await?;
    for query in [
        "CREATE TABLE IF NOT EXISTS routine_runs(run_id TEXT PRIMARY KEY,routine_id TEXT NOT NULL,started_at TEXT NOT NULL,data TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS routine_runs_recent ON routine_runs(routine_id,started_at DESC)",
        "CREATE TABLE IF NOT EXISTS primary_check_ins(id TEXT PRIMARY KEY,day TEXT NOT NULL,revision TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(day,revision))",
    ] {
        sqlx::query(query).execute(&mut *conn).await?;
    }
    Ok(())
}
pub async fn list(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    if store.get(Table::Routines, &id).await?.is_none() {
        return Err(ApiError::new(404, "例行任务不存在。"));
    }
    let mut conn = store.pool.acquire().await?;
    let rows = sqlx::query("SELECT data FROM routine_runs WHERE routine_id=? ORDER BY started_at DESC,rowid DESC LIMIT 20").bind(&id).fetch_all(&mut *conn).await?;
    let mut runs = Vec::with_capacity(rows.len());
    for row in rows {
        runs.push(view(&mut conn, decode(row.get("data"))?).await?);
    }
    grant.authorize(&state).await?;
    Ok(Json(json!({"routineId":id,"runs":runs})))
}
pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id, run)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    if store.get(Table::Routines, &id).await?.is_none() {
        return Err(ApiError::new(404, "例行任务不存在。"));
    }
    let row = sqlx::query("SELECT data FROM routine_runs WHERE routine_id=? AND run_id=?")
        .bind(&id)
        .bind(run)
        .fetch_optional(&store.pool)
        .await?
        .ok_or_else(|| ApiError::new(404, "运行记录不存在。"))?;
    let result = view(&mut *store.pool.acquire().await?, decode(row.get("data"))?).await?;
    grant.authorize(&state).await?;
    Ok(Json(result))
}
pub(crate) fn decode(data: String) -> Result<Value> {
    serde_json::from_str(&data).map_err(|_| ApiError::new(409, "运行记录暂不可用。"))
}
fn result_matches(run: &Value, result: &Value) -> bool {
    let marker = &result["metadata"]["routineRun"];
    result["role"] == "assistant"
        && result["agentId"] == run["agentId"]
        && result["conversationId"] == run["conversationId"]
        && marker["runId"] == run["runId"]
        && marker["routineId"] == run["routineId"]
        && marker["inputMessageId"] == run["inputMessageId"]
}
async fn view(conn: &mut SqliteConnection, mut run: Value) -> Result<Value> {
    let chat_exists = WorkspaceStore::get_in(
        conn,
        Table::Conversations,
        run["conversationId"].as_str().unwrap_or(""),
    )
    .await?
    .is_some();
    let input = WorkspaceStore::get_in(
        conn,
        Table::Messages,
        run["inputMessageId"].as_str().unwrap_or(""),
    )
    .await?;
    let input_valid = chat_exists
        && input.is_some_and(|m| {
            let marker = &m["metadata"]["routineRun"];
            m["conversationId"] == run["conversationId"]
                && ((m["role"] == "user" && m["delivery"]["agentId"] == run["agentId"])
                    || (m["role"] == "system" && m["agentId"] == run["agentId"]))
                && marker["runId"] == run["runId"]
                && marker["routineId"] == run["routineId"]
                && marker["inputMessageId"] == run["inputMessageId"]
        });
    // The result can remain navigable after its original input was deleted.
    let result = WorkspaceStore::get_in(
        conn,
        Table::Messages,
        run["resultMessageId"].as_str().unwrap_or(""),
    )
    .await?;
    let result_valid = chat_exists && result.is_some_and(|m| result_matches(&run, &m));
    if let Some(object) = run.as_object_mut() {
        object.remove("publicSearchGrant");
        if !input_valid {
            object.remove("inputMessageId");
        }
        if !result_valid {
            object.remove("resultMessageId");
        }
    }
    Ok(run)
}
pub(crate) async fn settle(
    conn: &mut SqliteConnection,
    input: &Value,
    result: &Value,
) -> Result<()> {
    super::operation_store::settle(conn, input, result).await?;
    let done = result["status"] == "done";
    let status = result["metadata"]["executionStatus"]
        .as_str()
        .unwrap_or(if done { "completed" } else { "error" });
    if let Some(run_id) = input["metadata"]["routineRun"]["runId"].as_str() {
        if let Some(row) = sqlx::query("SELECT data FROM routine_runs WHERE run_id=?")
            .bind(run_id)
            .fetch_optional(&mut *conn)
            .await?
        {
            let mut run = decode(row.get("data"))?;
            if run["status"] == "running" && run["inputMessageId"] == input["id"] {
                if !result_matches(&run, result)
                    || !["completed", "error", "cancelled", "interrupted"].contains(&status)
                {
                    return Err(ApiError::new(409, "运行结果与原记录不匹配。"));
                }
                run["status"] = json!(status);
                run["finishedAt"] = json!(iso(now()));
                run["resultMessageId"] = result["id"].clone();
                if !done {
                    run["error"] = json!(if status == "cancelled" {
                        "任务已停止，已完成的工作保留。"
                    } else {
                        "任务未确认完成，请核对聊天记录。"
                    });
                }
                sqlx::query("UPDATE routine_runs SET data=? WHERE run_id=?")
                    .bind(run.to_string())
                    .bind(run_id)
                    .execute(&mut *conn)
                    .await?;
            }
        }
    }
    if let Some(id) = input["metadata"]["primaryCheckIn"]["id"].as_str() {
        if let Some(row) = sqlx::query("SELECT data FROM primary_check_ins WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
        {
            let mut entry = decode(row.get("data"))?;
            if entry["status"] == "running" {
                entry["status"] = json!(if done {
                    "completed"
                } else if status == "cancelled" || status == "interrupted" {
                    "interrupted"
                } else {
                    "error"
                });
                entry["finishedAt"] = json!(iso(now()));
                if done {
                    entry["messageId"] = result["id"].clone();
                } else {
                    entry["reason"] = json!("此次主动跟进未确认完成，本日不会自动重试。");
                }
                sqlx::query("UPDATE primary_check_ins SET data=? WHERE id=?")
                    .bind(entry.to_string())
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
            }
        }
    }
    Ok(())
}
