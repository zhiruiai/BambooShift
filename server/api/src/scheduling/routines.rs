use crate::{
    db::{State, now},
    error::{ApiError, Body, Result, only_fields, text},
    workspace::{Table, WorkspaceStore, access, time_zone},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(crate) const WEBHOOK_SCHEDULE: &str = "webhook";

pub(crate) const CONFIG_FIELDS: &[&str] = &[
    "agentId",
    "conversationId",
    "title",
    "prompt",
    "schedule",
    "timeZone",
    "enabled",
    super::public_research::QUERIES,
];

pub(crate) async fn target(
    conn: &mut SqliteConnection,
    agent: &str,
    conversation: &str,
) -> Result<(Value, Value)> {
    let agent = WorkspaceStore::get_in(conn, Table::Agents, agent)
        .await?
        .ok_or_else(|| ApiError::new(404, "例行任务的 Bot 不存在。"))?;
    let conversation = WorkspaceStore::get_in(conn, Table::Conversations, conversation)
        .await?
        .ok_or_else(|| ApiError::new(404, "例行任务所属会话不存在。"))?;
    if !conversation["agentIds"]
        .as_array()
        .is_some_and(|ids| ids.contains(&agent["id"]))
    {
        return Err(ApiError::new(409, "例行任务的 Bot 已离开所属会话。"));
    }
    Ok((agent, conversation))
}

pub(crate) async fn webhook_target(
    conn: &mut SqliteConnection,
    agent: &str,
    conversation: &str,
) -> Result<(Value, Value)> {
    let (bot, chat) = target(conn, agent, conversation).await?;
    if bot.get("sharedBot").is_some()
        || chat["demo"] == true
        || chat["isGroup"] != false
        || chat["agentIds"] != json!([agent])
    {
        return Err(ApiError::new(409, "Webhook 仅适用于本地 Bot 的单人会话。")
            .with_code("ROUTINE_WEBHOOK_TARGET"));
    }
    Ok((bot, chat))
}

pub(crate) fn next_time(schedule: &str, at: i64, zone: Option<&Value>) -> Result<String> {
    if schedule == WEBHOOK_SCHEDULE {
        Ok(String::new())
    } else {
        time_zone::next(schedule, at, zone)
    }
}
pub(crate) fn config(value: &Value) -> Value {
    let mut result = json!({});
    for &key in CONFIG_FIELDS {
        if let Some(v) = value.get(key) {
            result[key] = v.clone();
        }
    }
    result
}
pub(crate) async fn validate(
    conn: &mut SqliteConnection,
    body: &Value,
    old: Option<&Value>,
    at: i64,
) -> Result<Value> {
    only_fields(
        body,
        &[
            "agentId",
            "conversationId",
            "title",
            "prompt",
            "schedule",
            "timeZone",
            "enabled",
        ],
    )?;
    let prior = old.cloned().unwrap_or(json!({}));
    let field = |name: &str| body.get(name).unwrap_or(&prior[name]).clone();
    let agent = text(&field("agentId"), "Bot", 160)?;
    let conversation = if let Some(id) = field("conversationId").as_str() {
        id.to_owned()
    } else {
        WorkspaceStore::list_in(conn, Table::Conversations)
            .await?
            .iter()
            .find(|c| {
                c["isGroup"] == false
                    && c["agentIds"]
                        .as_array()
                        .is_some_and(|ids| ids.contains(&json!(agent)))
            })
            .and_then(|c| c["id"].as_str())
            .map(str::to_owned)
            .ok_or_else(|| ApiError::bad("请选择例行任务所属会话。"))?
    };
    let schedule_value = field("schedule");
    let requested_schedule = schedule_value.as_str().unwrap_or("daily:09:00");
    let schedule = if requested_schedule == WEBHOOK_SCHEDULE {
        webhook_target(conn, &agent, &conversation).await?;
        WEBHOOK_SCHEDULE.to_owned()
    } else {
        target(conn, &agent, &conversation).await?;
        time_zone::normalize_schedule(requested_schedule)?
    };
    let zone = if let Some(zone) = body.get("timeZone") {
        time_zone::normalize(zone)?
    } else if old.is_some() {
        time_zone::effective(prior.get("timeZone"))?
    } else {
        time_zone::read(conn).await?["timeZone"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let enabled = if let Some(value) = body.get("enabled") {
        value
            .as_bool()
            .ok_or_else(|| ApiError::bad("例行任务开关无效。"))?
    } else {
        prior["enabled"].as_bool().unwrap_or(true)
    };
    let next = next_time(&schedule, at, Some(&json!(zone)))?;
    let prior_schedule = prior["schedule"].as_str().and_then(|s| {
        if s == WEBHOOK_SCHEDULE {
            Some(s.to_owned())
        } else {
            time_zone::normalize_schedule(s).ok()
        }
    });
    let prior_zone = time_zone::effective(prior.get("timeZone")).ok();
    let schedule_changed = old.is_none()
        || prior_schedule.as_deref() != Some(&schedule)
        || prior_zone.as_deref() != Some(&zone)
        || (prior["enabled"] == false && enabled);
    let mut result = json!({"id":prior["id"].as_str().map(str::to_owned).unwrap_or_else(||uuid::Uuid::new_v4().to_string()),"agentId":agent,"conversationId":conversation,"title":text(&field("title"),"任务标题",100)?,"prompt":text(&field("prompt"),"任务内容",12000)?,"schedule":schedule,"enabled":enabled,"nextRunAt":if schedule_changed{json!(next)}else{prior["nextRunAt"].clone()}});
    if old.is_none() || prior.get("timeZone").is_some() || body.get("timeZone").is_some() {
        result["timeZone"] = json!(zone);
    }
    if let Some(last) = prior.get("lastRunAt") {
        result["lastRunAt"] = last.clone();
    }
    if result["agentId"] == prior["agentId"] && result["conversationId"] == prior["conversationId"]
    {
        if let Some(queries) = prior.get(super::public_research::QUERIES) {
            result[super::public_research::QUERIES] = queries.clone();
        }
    }
    Ok(result)
}

pub(crate) fn pause(mut routine: Value) -> Value {
    routine["enabled"] = json!(false);
    routine
}

pub(crate) async fn save_owned(
    tx: &mut SqliteConnection,
    body: &Value,
    old: Option<&Value>,
    at: i64,
    owner: &str,
) -> Result<Value> {
    let mut settings = body.clone();
    let fields = settings
        .as_object_mut()
        .ok_or_else(|| ApiError::bad("例行任务设置无效。"))?;
    let queries = fields.remove(super::public_research::QUERIES);
    let expected = fields.remove("expectedRoutine");
    if (queries.is_some() || expected.is_some()) && old.is_some() && old.map(config) != expected {
        return Err(super::public_research::changed());
    }
    if old.is_none() && expected.is_some() {
        return Err(ApiError::bad("新例行任务无需旧配置。"));
    }
    let mut routine = match old {
        Some(old) if settings == json!({"enabled":false}) && queries.is_none() => {
            pause(old.clone())
        }
        _ => validate(tx, &settings, old, at).await?,
    };
    if let Some(old) = old {
        if routine["agentId"] != old["agentId"]
            || routine["conversationId"] != old["conversationId"]
        {
            let chat = WorkspaceStore::get_in(
                tx,
                Table::Conversations,
                old["conversationId"].as_str().unwrap_or(""),
            )
            .await?;
            if routine["conversationId"] != old["conversationId"]
                || chat.is_none_or(|chat| chat["isGroup"] != true)
            {
                return Err(
                    ApiError::new(409, "请使用“转交给 Bot”明确确认单聊例行任务的接收者。")
                        .with_code("ROUTINE_TRANSFER_REQUIRED"),
                );
            }
        }
    }
    if let Some(value) = queries.as_ref() {
        super::public_research::apply(tx, &mut routine, value).await?;
    }
    WorkspaceStore::put_in(tx, Table::Routines, &routine).await?;
    if queries.is_some() {
        super::public_research::write_grant(tx, &routine, owner).await?;
    }
    Ok(routine)
}
pub async fn create(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let routine = save_owned(&mut tx, &body, None, now(), &grant.user_id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok((StatusCode::CREATED, Json(routine)))
}
pub async fn edit(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let old = WorkspaceStore::get_in(&mut tx, Table::Routines, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "例行任务不存在。"))?;
    let routine = save_owned(&mut tx, &body, Some(&old), now(), &grant.user_id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(Json(routine))
}
pub async fn remove(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    only_fields(&body, &["expectedRoutine"])?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let routine = WorkspaceStore::get_in(&mut tx, Table::Routines, &id)
        .await?
        .ok_or_else(|| ApiError::new(404, "例行任务不存在。"))?;
    if let Some(expected) = body.get("expectedRoutine") {
        if *expected != config(&routine) {
            return Err(ApiError::new(409, "任务配置已变化，请重新查看后再删除。")
                .with_code("ROUTINE_CHANGED"));
        }
    }
    WorkspaceStore::delete_in(&mut tx, Table::Routines, &id).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(Json(json!({"ok":true})))
}
