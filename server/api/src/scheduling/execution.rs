use super::routines;
use crate::{
    agent::{
        admission::Reservation,
        authority::{BackgroundAccess, ExecutionAccess},
    },
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq)]
enum Trigger {
    Scheduled,
    Manual,
    Webhook,
}

impl Trigger {
    fn label(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
            Self::Webhook => "webhook",
        }
    }
}

pub async fn manual(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let routine = store
        .get(Table::Routines, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "例行任务不存在。"))?;
    let input = run_routine(
        &state,
        &store,
        &routine,
        ExecutionAccess::User(grant),
        false,
        now(),
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"ok":true,"message":input})),
    ))
}
pub(crate) async fn scheduled(
    state: &State,
    store: &Arc<WorkspaceStore>,
    routine: &Value,
    at: i64,
) -> Result<Value> {
    let grant = BackgroundAccess::capture(state, &store.workspace_id, None).await?;
    run_routine(
        state,
        store,
        routine,
        ExecutionAccess::Background(grant),
        true,
        at,
    )
    .await
}
pub(crate) async fn run_routine(
    state: &State,
    store: &Arc<WorkspaceStore>,
    routine: &Value,
    grant: ExecutionAccess,
    scheduled: bool,
    at: i64,
) -> Result<Value> {
    let cid = routine["conversationId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("例行任务会话无效。"))?;
    let agent = routine["agentId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("例行任务 Bot 无效。"))?;
    let mid = uuid::Uuid::new_v4().to_string();
    let reservation = Reservation::reserve_kind(state, &grant, cid, agent, &mid, "routine").await?;
    let mut tx = store.begin().await?;
    let current = WorkspaceStore::get_in(
        &mut tx,
        Table::Routines,
        routine["id"].as_str().unwrap_or(""),
    )
    .await?
    .ok_or_else(|| ApiError::new(404, "例行任务不存在。"))?;
    if routines::config(&current) != routines::config(routine)
        || current["nextRunAt"] != routine["nextRunAt"]
        || (scheduled && current["enabled"] != true)
    {
        return Err(ApiError::new(409, "任务安排已变化，本次没有启动。"));
    }
    let (input, _) = persist_run(
        &mut tx,
        &current,
        &grant,
        scheduled,
        at,
        &mid,
        &reservation.active.run_id,
        None,
    )
    .await?;
    grant.authorize(state).await?;
    tx.commit().await?;
    store.emit("message", input.clone());
    store.emit("update", json!({}));
    reservation.launch(state.clone(), grant, store.clone(), input.clone());
    Ok(input)
}

/// The caller holds the workspace transaction and the conversation reservation.
pub(crate) async fn persist_run(
    conn: &mut SqliteConnection,
    current: &Value,
    grant: &ExecutionAccess,
    scheduled: bool,
    at: i64,
    mid: &str,
    active_run_id: &str,
    operation: Option<&str>,
) -> Result<(Value, Value)> {
    let trigger = if scheduled {
        Trigger::Scheduled
    } else {
        Trigger::Manual
    };
    persist(
        conn,
        current,
        grant,
        trigger,
        at,
        mid,
        active_run_id,
        operation,
    )
    .await
}

pub(crate) async fn persist_webhook(
    conn: &mut SqliteConnection,
    current: &Value,
    grant: &ExecutionAccess,
    at: i64,
    mid: &str,
    active_run_id: &str,
) -> Result<Value> {
    let (input, _) = persist(
        conn,
        current,
        grant,
        Trigger::Webhook,
        at,
        mid,
        active_run_id,
        None,
    )
    .await?;
    Ok(input)
}

async fn persist(
    conn: &mut SqliteConnection,
    current: &Value,
    grant: &ExecutionAccess,
    trigger: Trigger,
    at: i64,
    mid: &str,
    active_run_id: &str,
    operation: Option<&str>,
) -> Result<(Value, Value)> {
    let cid = current["conversationId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("会话无效。"))?;
    let agent = current["agentId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Bot 无效。"))?;
    let webhook = trigger == Trigger::Webhook;
    let manual = trigger == Trigger::Manual;
    let (mut bot, mut chat) = if webhook {
        routines::webhook_target(conn, agent, cid).await?
    } else {
        routines::target(conn, agent, cid).await?
    };
    let created = iso(at);
    let mut input = json!({"id":mid,"conversationId":cid,"agentId":agent,"role":if manual{"user"}else{"system"},"kind":"text","content":format!("例行任务：{}",current["title"].as_str().unwrap_or("")),"executionPrompt":current["prompt"],"createdAt":created,"delivery":{"state":"queued","mode":"followUp","agentId":agent,"runId":active_run_id},"metadata":{"routineRun":{"runId":mid,"routineId":current["id"],"inputMessageId":mid}}});
    if webhook {
        input["metadata"]["routineRun"]["trigger"] = json!("webhook");
    }
    if let Some(request_id) = operation {
        input["delivery"]["clientId"] = json!(request_id);
        input["metadata"]["routineOperation"] =
            json!({"requestId":request_id,"routineId":current["id"]});
        input["content"] = json!(format!(
            "立即运行例行任务：{}\n\n{}",
            current["title"].as_str().unwrap_or(""),
            current["prompt"].as_str().unwrap_or("")
        ));
    }
    if manual {
        input["userId"] = json!(grant.user_id());
        input["metadata"]["author"] =
            json!({"id":grant.user_id(),"name":grant.user_name(),"kind":"user"});
    }
    let mut changed = current.clone();
    changed["lastRunAt"] = json!(created);
    if !webhook {
        changed["nextRunAt"] = json!(routines::next_time(
            current["schedule"].as_str().unwrap_or(""),
            at,
            current.get("timeZone")
        )?);
    }
    let run = json!({"runId":mid,"routineId":current["id"],"agentId":agent,"conversationId":cid,"inputMessageId":mid,"trigger":trigger.label(),"status":"running","startedAt":created});
    let mut run = run;
    run["routineConfig"] = routines::config(current);
    if !webhook {
        if let Some(revision) =
            super::public_research::admitted_revision(conn, current, grant, !manual).await?
        {
            run["publicSearchGrant"] = json!(revision);
        }
    }
    sqlx::query("INSERT INTO routine_runs(run_id,routine_id,started_at,data) VALUES(?,?,?,?)")
        .bind(&mid)
        .bind(current["id"].as_str())
        .bind(&created)
        .bind(run.to_string())
        .execute(&mut *conn)
        .await?;
    WorkspaceStore::put_in(conn, Table::Routines, &changed).await?;
    WorkspaceStore::put_in(conn, Table::Messages, &input).await?;
    bot["status"] = json!("working");
    chat["updatedAt"] = json!(created);
    WorkspaceStore::put_in(conn, Table::Agents, &bot).await?;
    WorkspaceStore::put_in(conn, Table::Conversations, &chat).await?;
    Ok((input, changed["nextRunAt"].clone()))
}
