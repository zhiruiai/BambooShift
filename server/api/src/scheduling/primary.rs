use crate::{
    agent::{
        admission::Reservation,
        authority::{BackgroundAccess, ExecutionAccess},
    },
    db::{State, iso},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore, primary, time_zone},
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::sync::Arc;

pub(crate) async fn status(
    conn: &mut SqliteConnection,
    kind: &str,
    configured: bool,
    at: i64,
) -> Result<Value> {
    let config = primary::read(conn, kind).await?;
    if config["available"] != true
        || config["agentId"].is_null()
        || config["conversationId"].is_null()
        || config["checkIn"]["enabled"] != true
    {
        return Ok(json!({"status":"disabled"}));
    }
    let schedule = format!("daily:{}", config["checkIn"]["time"].as_str().unwrap_or(""));
    let next = match time_zone::next(&schedule, at, config["checkIn"].get("timeZone")) {
        Ok(next) => next,
        Err(_) => {
            return Ok(json!({"status":"error","reason":"主动跟进时区或时间无效，请重新设置。"}));
        }
    };
    let row = sqlx::query(
        "SELECT data FROM primary_check_ins WHERE revision=? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(config["revision"].as_str())
    .fetch_optional(&mut *conn)
    .await?;
    let mut value = json!({"status":if configured{"waiting"}else{"no_model"},"nextRunAt":next});
    if let Some(row) = row {
        let entry = super::history::decode(row.get("data"))?;
        if configured {
            value["status"] = entry["status"].clone();
        }
        value["lastRunAt"] = entry["startedAt"].clone();
        for (target, source) in [("lastMessageId", "messageId"), ("reason", "reason")] {
            if let Some(v) = entry.get(source) {
                value[target] = v.clone();
            }
        }
    }
    Ok(value)
}
pub(crate) async fn tick(
    state: &State,
    store: &Arc<WorkspaceStore>,
    kind: &str,
    at: i64,
) -> Result<()> {
    let config = primary::read(&mut *store.pool.acquire().await?, kind).await?;
    if config["available"] != true || config["checkIn"]["enabled"] != true {
        return Ok(());
    }
    let Some(agent) = config["agentId"].as_str() else {
        return Ok(());
    };
    let Some(cid) = config["conversationId"].as_str() else {
        return Ok(());
    };
    let day = time_zone::local_day(at, config["checkIn"].get("timeZone"))?;
    let Some(due) = time_zone::slot(
        day,
        config["checkIn"]["time"].as_str().unwrap_or(""),
        config["checkIn"].get("timeZone"),
    )?
    else {
        return Ok(());
    };
    let activated = config["updatedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis());
    if due > at || activated.is_none_or(|activated| due <= activated) {
        return Ok(());
    }
    if state.agent_runs.workspace_busy(&store.workspace_id).await {
        return Ok(());
    }
    if crate::workspace::model::runtime_config(store).await?["configured"] != true {
        return Ok(());
    }
    let grant = ExecutionAccess::Background(
        BackgroundAccess::capture(
            state,
            &store.workspace_id,
            config["revision"].as_str().map(str::to_owned),
        )
        .await?,
    );
    let id = uuid::Uuid::new_v4().to_string();
    let reservation =
        Reservation::reserve_kind(state, &grant, cid, agent, &id, "primary_checkin").await?;
    let mut tx = store.begin().await?;
    let current = primary::read(&mut tx, kind).await?;
    if current["revision"] != config["revision"] {
        return Err(ApiError::new(409, "主 Bot 设置已变化。"));
    }
    if sqlx::query("SELECT id FROM primary_check_ins WHERE day=? AND revision=?")
        .bind(day.to_string())
        .bind(config["revision"].as_str())
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    {
        return Ok(());
    }
    let (mut bot, mut chat) = super::routines::target(&mut tx, agent, cid).await?;
    let started = iso(at);
    let entry = json!({"id":id,"day":day.to_string(),"revision":config["revision"],"agentId":agent,"conversationId":cid,"startedAt":started,"status":"running"});
    let input = json!({"id":id,"conversationId":cid,"agentId":agent,"role":"system","kind":"activity","content":"每日主动跟进","executionPrompt":"Give a brief, useful daily check-in using only available workspace context. Be clear about uncertainty. Do not invent completed work, external events or reminders. Use only the provided read-only knowledge tools, if any. You cannot perform actions or modify data in this check-in.","createdAt":started,"delivery":{"state":"queued","mode":"followUp","agentId":agent,"runId":reservation.active.run_id},"metadata":{"primaryCheckIn":{"id":id,"revision":config["revision"],"scheduledFor":iso(due)}}});
    sqlx::query("INSERT INTO primary_check_ins(id,day,revision,data) VALUES(?,?,?,?)")
        .bind(&id)
        .bind(day.to_string())
        .bind(config["revision"].as_str())
        .bind(entry.to_string())
        .execute(&mut *tx)
        .await?;
    WorkspaceStore::put_in(&mut tx, Table::Messages, &input).await?;
    bot["status"] = json!("working");
    chat["updatedAt"] = json!(started);
    WorkspaceStore::put_in(&mut tx, Table::Agents, &bot).await?;
    WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
    grant.authorize(state).await?;
    tx.commit().await?;
    store.emit("message", input.clone());
    store.emit("update", json!({}));
    reservation.launch(state.clone(), grant, store.clone(), input);
    Ok(())
}
