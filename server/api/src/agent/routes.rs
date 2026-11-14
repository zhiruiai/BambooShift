use super::{
    admission::Reservation,
    app_context::{self, AppContext},
    authority::ExecutionAccess,
    mentions, messages,
    registry::AgentRegistry,
    selected_skill, threads, voice_memo,
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields, text},
    speech::calls as voice_calls,
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State as Extract},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

pub fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/workspaces/{wid}/messages/{mid}/answer",
            post(super::questions::answer),
        )
        .route(
            "/api/workspaces/{wid}/conversations/{cid}/messages",
            post(submit),
        )
        .route("/api/workspaces/{wid}/conversations/{cid}/stop", post(stop))
        .route(
            "/api/workspaces/{wid}/messages/{mid}/reactions",
            post(messages::react),
        )
        .layer(DefaultBodyLimit::max(160 * 1024))
}
async fn submit(
    Extract(state): Extract<State>,
    Path((wid, cid)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    only_fields(
        &body,
        &[
            "content",
            "clientId",
            "agentId",
            "mode",
            "replyToMessageId",
            "threadRootId",
            "appContext",
            "skillId",
            "mentions",
            "voiceCallId",
            "requestVoiceMemo",
        ],
    )?;
    let mode = body["mode"].as_str().unwrap_or("steer");
    if !["steer", "followUp"].contains(&mode) {
        return Err(ApiError::bad("消息发送方式无效。"));
    }
    let voice_call = voice_calls::requested(body.get("voiceCallId"))?;
    let voice_memo = voice_memo::requested(&body, mode)?;
    if voice_call.is_some()
        && (mode != "followUp"
            || [
                "threadRootId",
                "replyToMessageId",
                "appContext",
                "skillId",
                "mentions",
                "agentId",
            ]
            .iter()
            .any(|key| body.get(key).is_some()))
    {
        return Err(voice_calls::invalid());
    }
    let requested_mentions = mentions::request(body.get("mentions"))?;
    let requested_skill = selected_skill::request(body.get("skillId"))?;
    let mode = if requested_skill.is_some() {
        "followUp"
    } else {
        mode
    };
    if requested_mentions.is_some()
        && (body.get("agentId").is_some() || body.get("appContext").is_some())
    {
        return Err(mentions::invalid());
    }
    let thread = threads::request(body.get("threadRootId"))?;
    let reply_id = if body["replyToMessageId"].is_null() {
        json!(thread)
    } else {
        body["replyToMessageId"].clone()
    };
    let requested_app = app_context::request(body.get("appContext"))?;
    let content = text(&body["content"], "消息", 30000)?;
    let client = body["clientId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("消息请求标识无效。"))?;
    if !messages::opaque(client) || client.starts_with("question-answer-") {
        return Err(ApiError::bad("消息请求标识无效。"));
    }
    let key = AgentRegistry::key(&wid, &cid);
    let admission = state.agent_runs.admission(&wid).await?;
    let _gate = state.agent_runs.queues.lock(&key).await;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let conversation = WorkspaceStore::get_in(&mut tx, Table::Conversations, &cid)
        .await?
        .ok_or_else(|| ApiError::new(404, "会话不存在。"))?;
    for message in WorkspaceStore::list_in(&mut tx, Table::Messages).await? {
        if message["role"] == "user"
            && message["conversationId"] == cid
            && message["userId"] == grant.user_id
            && message["delivery"]["clientId"] == client
        {
            if message["content"] != content
                || message["delivery"]["mode"] != mode
                || message["delivery"]["explicitAgentId"] != body["agentId"]
                || message["replyTo"]["id"] != reply_id
                || !threads::belongs(&message, thread)
                || message["appContext"]["connectionId"] != body["appContext"]["connectionId"]
                || message["appContext"]["revision"] != body["appContext"]["revision"]
                || message["skillId"] != body["skillId"]
                || message["metadata"]["voiceCallId"] != body["voiceCallId"]
                || (message["metadata"]["requestVoiceMemo"] == true) != voice_memo
                || !mentions::same_intent(requested_mentions.as_ref(), &message)
            {
                return Err(ApiError::new(409, "同一消息请求不能用于不同内容。"));
            }
            grant.authorize(&state).await?;
            return Ok((StatusCode::ACCEPTED, Json(json!({"message":message}))));
        }
    }
    let voice_agent = match voice_call {
        Some(id) => {
            Some(voice_calls::accept_turn(&mut tx, &grant.user_id, &cid, id, &conversation).await?)
        }
        None => None,
    };
    let root = match thread {
        Some(id) => Some(threads::root(&mut tx, &cid, id).await?),
        None => None,
    };
    let reply = messages::reply(&mut tx, &cid, &reply_id, thread).await?;
    let agents = WorkspaceStore::list_in(&mut tx, Table::Agents).await?;
    let group_mentions = requested_mentions
        .as_ref()
        .map(|intent| mentions::resolve(intent, &conversation))
        .transpose()?;
    if let Some(resolved) = &group_mentions {
        for id in mentions::ids(resolved) {
            let agent = agents
                .iter()
                .find(|agent| agent["id"] == id)
                .ok_or_else(mentions::unavailable)?;
            if agent.get("sharedBot").is_some() {
                crate::shared_bots::resolve(&state, &grant, id)
                    .await
                    .map_err(|_| mentions::unavailable())?;
            }
        }
    }
    let explicit = body.get("agentId");
    if explicit.is_some_and(|id| !id.is_string()) {
        return Err(ApiError::bad("请选择当前会话中的有效 Bot。"));
    }
    let mentioned = agents.iter().find(|agent| {
        conversation["agentIds"]
            .as_array()
            .is_some_and(|ids| ids.contains(&agent["id"]))
            && agent["name"]
                .as_str()
                .is_some_and(|name| content.contains(&format!("@{name}")))
    });
    let active = state.agent_runs.get(&key).await;
    if voice_call.is_some() && (active.is_some() || state.agent_runs.queues.len(&key).await > 0) {
        return Err(voice_calls::busy());
    }
    if active
        .as_ref()
        .is_some_and(|run| run.cancelled.load(std::sync::atomic::Ordering::Acquire))
    {
        return Err(ApiError::new(409, "任务正在停止，请稍后发送。"));
    }
    let member = |id: &&str| {
        conversation["agentIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|member| member.as_str() == Some(*id)))
    };
    let scoped_active = active.as_ref().filter(|run| {
        run.thread_root_id.as_deref() == thread
            && run.family.mentioned_agents.get().is_none()
            && run.family.selected_skill.get().is_none()
    });
    let agent_id = voice_agent
        .as_deref()
        .or_else(|| {
            group_mentions
                .as_ref()
                .and_then(|value| mentions::ids(value).next())
        })
        .or_else(|| explicit.and_then(Value::as_str))
        .or_else(|| mentioned.and_then(|a| a["id"].as_str()))
        .or_else(|| {
            reply
                .as_ref()
                .and_then(|r| r["agentId"].as_str())
                .filter(member)
        })
        .or_else(|| scoped_active.map(|a| a.agent_id.as_str()))
        .or_else(|| {
            root.as_ref()
                .and_then(|message| message["delivery"]["agentId"].as_str())
                .filter(member)
        })
        .or_else(|| conversation["agentIds"][0].as_str())
        .ok_or_else(|| ApiError::bad("请选择负责的 Bot。"))?
        .to_owned();
    if !conversation["agentIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == &agent_id))
    {
        return Err(ApiError::new(409, "所选 Bot 已离开当前会话。"));
    }
    let agent = WorkspaceStore::get_in(&mut tx, Table::Agents, &agent_id)
        .await?
        .ok_or_else(|| ApiError::new(404, "Bot 不存在。"))?;
    if let Some(id) = requested_skill {
        if explicit.is_none() || agent.get("sharedBot").is_some() {
            return Err(selected_skill::unavailable());
        }
        selected_skill::check(&mut tx, id, &agent_id).await?;
    }
    if voice_memo {
        voice_memo::authorize_submission(&state, &grant, &conversation, &agent).await?;
        if !crate::workspace::model::bot_configured_in(&store, &mut tx, &agent_id).await? {
            return Err(voice_memo::unavailable());
        }
    }
    if group_mentions.is_none() && agent.get("sharedBot").is_some() {
        if requested_app.is_some() {
            return Err(AppContext::local_only());
        }
        crate::shared_bots::resolve(&state, &grant, &agent_id).await?;
    }
    let app = match requested_app {
        Some((id, revision)) => Some(AppContext::capture(&mut tx, id, revision).await?),
        None => None,
    };
    let isolated = voice_memo
        || group_mentions.is_some()
        || app.is_some()
        || requested_skill.is_some()
        || active.as_ref().is_some_and(|run| {
            run.family.isolated_dispatch() || run.thread_root_id.as_deref() != thread
        })
        || state.agent_runs.queues.has_isolated_dispatch(&key).await;
    let message_id = Uuid::new_v4().to_string();
    let authority = ExecutionAccess::User(grant.clone());
    let targets = group_mentions
        .as_ref()
        .map_or(1, |value| mentions::ids(value).count());
    let waiting = targets - usize::from(active.is_none());
    if state.agent_runs.queues.len(&key).await + waiting > 20 {
        return Err(ApiError::new(
            429,
            "等待处理的消息已达20条，请先等待或停止当前任务。",
        ));
    }
    let reservation = if active.is_none() {
        Some(
            Reservation::reserve_scoped(
                &state,
                &authority,
                &cid,
                &agent_id,
                &message_id,
                "user",
                thread,
            )
            .await?,
        )
    } else {
        None
    };
    let run_id = reservation
        .as_ref()
        .map(|reservation| reservation.active.run_id.clone());
    let mut message = json!({"id":message_id,"conversationId":cid,"userId":grant.user_id,"role":"user","kind":"text","content":content,"createdAt":iso(now()),"delivery":{"state":"queued","mode":mode,"agentId":agent_id,"clientId":client,"runId":run_id}});
    threads::stamp(&mut message, thread);
    if let Some(resolved) = group_mentions {
        mentions::attach(&mut message, resolved, run_id.as_deref());
    }
    if body.get("agentId").is_some() {
        message["delivery"]["explicitAgentId"] = body["agentId"].clone();
    }
    message["metadata"] =
        json!({"author":{"id":grant.user_id,"name":grant.user_name,"kind":"user"}});
    if let Some(id) = voice_call {
        message["metadata"]["voiceCallId"] = json!(id);
    }
    if voice_memo {
        message["metadata"]["requestVoiceMemo"] = json!(true);
    }
    if let Some(reply) = reply {
        message["replyTo"] = reply;
    }
    if let Some(app) = app {
        message["appContext"] = json!(app);
    }
    if let Some(id) = requested_skill {
        message["skillId"] = json!(id);
    }
    let steering_generation = if mode == "steer" && !isolated {
        active
            .as_ref()
            .filter(|run| {
                (run.kind == "user" || (run.kind == "routine" && !run.background))
                    && run.user_id == grant.user_id
                    && run.agent_id == agent_id
            })
            .map(|run| run.generation.load(std::sync::atomic::Ordering::Acquire) + 1)
    } else {
        None
    };
    // Identity is rechecked after the last database write, before committing.
    persist_submission(
        &state,
        &grant,
        tx,
        &message,
        &conversation,
        if reservation.is_some() {
            Some(&agent)
        } else {
            None
        },
    )
    .await?;
    if let (Some(run), Some(generation)) = (active.as_ref(), steering_generation) {
        run.generation
            .store(generation, std::sync::atomic::Ordering::Release);
    }
    store.emit("message", message.clone());
    store.emit("update", json!({}));
    let input = message.clone();
    if let Some(reservation) = reservation {
        if input.get("mentions").is_some() {
            let accepted_state = state.clone();
            tokio::spawn(async move {
                let _gate = _gate;
                let _admission = admission;
                accepted_state
                    .agent_runs
                    .queues
                    .push_user(&key, authority.clone(), input.clone(), None, true)
                    .await;
                reservation.launch(accepted_state, authority, store, input);
            });
        } else {
            reservation.launch(state.clone(), authority, store, input);
        }
    } else {
        let accepted_state = state.clone();
        let accepted_workspace = wid.clone();
        let actor = grant.user_id.clone();
        tokio::spawn(async move {
            let _gate = _gate;
            let _admission = admission;
            accepted_state
                .agent_runs
                .queues
                .push_user(&key, authority, input, steering_generation, false)
                .await;
            if let Some(active) = active.filter(|_| !isolated) {
                if (active.kind == "user" || (active.kind == "routine" && !active.background))
                    && active.user_id == actor
                    && active.agent_id == agent_id
                {
                    let _ = active.commands.send(json!({"type":"inject"})).await;
                }
            }
            accepted_state
                .agent_runs
                .yield_check_ins(&accepted_workspace)
                .await;
        });
    }
    let yielding = state.clone();
    tokio::spawn(async move {
        yielding.agent_runs.yield_check_ins(&wid).await;
    });
    Ok((StatusCode::ACCEPTED, Json(json!({"message":message}))))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopQuery {
    thread_root_id: Option<String>,
    scope: Option<String>,
}

async fn stop(
    Extract(state): Extract<State>,
    Path((wid, cid)): Path<(String, String)>,
    Query(query): Query<StopQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let scope = match (query.thread_root_id.as_deref(), query.scope.as_deref()) {
        (None, None) => None,
        (None, Some("main")) => Some(None),
        (Some(id), None) if messages::opaque(id) => Some(Some(id)),
        _ => return Err(ApiError::bad("请选择有效的任务范围。")),
    };
    let key = AgentRegistry::key(&wid, &cid);
    let _gate = state.agent_runs.queues.lock(&key).await;
    let store = grant.store(&state).await?;
    let mut cancel_user_queue = true;
    if let Some(active) = state.agent_runs.get(&key).await {
        cancel_user_queue = active.kind != "memory_import";
        if active.user_id != grant.user_id {
            return Err(ApiError::new(403, "只能停止自己发起的任务。"));
        }
        if scope.is_some_and(|scope| scope != active.thread_root_id.as_deref()) {
            return Err(threads::unavailable());
        }
        active
            .cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        active
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let abort = active
            .commands
            .send(json!({"type":"abort","runId":active.run_id}))
            .await;
        if abort.is_err() && active.family.mentioned_agents.get().is_none() {
            return Err(ApiError::new(409, "任务已经结束。"));
        }
    }
    if cancel_user_queue {
        state
            .agent_runs
            .queues
            .cancel_actor(
                &key,
                &grant.user_id,
                scope,
                true,
                &store,
                "发起者已取消等待中的消息。",
            )
            .await?;
    }
    Ok(Json(json!({"ok":true})))
}

async fn persist_submission(
    state: &State,
    grant: &crate::workspace::WorkspaceAccess,
    mut tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    message: &Value,
    conversation: &Value,
    agent: Option<&Value>,
) -> Result<()> {
    WorkspaceStore::put_in(&mut tx, Table::Messages, message).await?;
    let mut changed = conversation.clone();
    changed["updatedAt"] = message["createdAt"].clone();
    WorkspaceStore::put_in(&mut tx, Table::Conversations, &changed).await?;
    if let Some(agent) = agent {
        let mut working = agent.clone();
        working["status"] = json!("working");
        WorkspaceStore::put_in(&mut tx, Table::Agents, &working).await?;
    }
    grant.authorize(state).await?;
    tx.commit().await?;
    Ok(())
}
