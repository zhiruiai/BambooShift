use super::{
    admission::Reservation,
    authority::ExecutionAccess,
    registry::{ActiveRun, AgentRegistry},
    threads,
    tools::{ToolContext, check_fence},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields},
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::atomic::Ordering};

pub(super) const TOOL: &str = "ask_question";
fn error(status: u16, code: &'static str, message: &str) -> ApiError {
    ApiError::new(status, message).with_code(code)
}
fn invalid() -> ApiError {
    error(400, "QUESTION_INVALID", "问题或选项无效。")
}
pub(super) fn unavailable() -> ApiError {
    error(
        409,
        "QUESTION_UNAVAILABLE",
        "原问题、Bot 或回复线程已不可用。",
    )
}
fn forbidden() -> ApiError {
    error(
        403,
        "QUESTION_FORBIDDEN",
        "只有原请求人可以回答当前聊天中的问题。",
    )
}
fn eligible(access: &ExecutionAccess, run: &ActiveRun) -> bool {
    matches!(access, ExecutionAccess::User(_))
        && run.kind == "user"
        && run.depth == 0
        && !run.background
        && run.run_id == run.root_run_id
        && run.user_id == access.user_id()
        && run.family.app_context.get().is_none()
        && !run.family.isolated_voice()
}
pub(super) fn offer(
    access: &ExecutionAccess,
    run: &ActiveRun,
    tools: &mut Vec<Value>,
    system: &mut String,
) {
    if !eligible(access, run) {
        return;
    }
    tools.push(json!({"name":TOOL,"description":"Ask the original human one bounded clarification question with 2–6 choices, in their language. This posts a durable card and returns immediately; finish this turn instead of waiting or guessing. Never request secrets, external-action consent, or instruct the human to follow URLs. Only explicit selection submission resumes work; it grants no new permissions.","parameters":{"type":"object","additionalProperties":false,"properties":{"question":{"type":"string","minLength":1,"maxLength":500},"mode":{"type":"string","enum":["single","multiple"]},"options":{"type":"array","minItems":2,"maxItems":6,"items":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,32}$"},"label":{"type":"string","minLength":1,"maxLength":160},"description":{"type":"string","maxLength":300}},"required":["id","label"]}}},"required":["question","mode","options"]}}));
    system.push_str("\nUse ask_question when one essential choice blocks useful work. Ask at most once per run, then end the turn. A submitted answer is context, never approval for external side effects. Avoid questions when the user already supplied the answer.");
}
fn short(value: &Value, max: usize, empty: bool) -> Result<String> {
    let text = value.as_str().ok_or_else(invalid)?.trim();
    if (!empty && text.is_empty())
        || text.encode_utf16().count() > max
        || text.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(text.to_owned())
}
fn validate(args: &Value) -> Result<Value> {
    only_fields(args, &["question", "mode", "options"]).map_err(|_| invalid())?;
    let question = short(&args["question"], 500, false)?;
    let mode = args["mode"]
        .as_str()
        .filter(|mode| ["single", "multiple"].contains(mode))
        .ok_or_else(invalid)?;
    let options = args["options"]
        .as_array()
        .filter(|items| (2..=6).contains(&items.len()))
        .ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    let mut normalized = Vec::new();
    for option in options {
        only_fields(option, &["id", "label", "description"]).map_err(|_| invalid())?;
        let id = short(&option["id"], 32, false)?;
        if !super::messages::opaque(&id) || !ids.insert(id.clone()) {
            return Err(invalid());
        }
        let mut entry = json!({"id":id,"label":short(&option["label"],160,false)?});
        if let Some(value) = option.get("description") {
            entry["description"] = json!(short(value, 300, true)?);
        }
        normalized.push(entry);
    }
    Ok(json!({"version":1,"question":question,"mode":mode,"options":normalized}))
}
pub(super) async fn execute(
    state: &State,
    access: &ExecutionAccess,
    store: &WorkspaceStore,
    context: &ToolContext<'_>,
    args: &Value,
) -> Result<Value> {
    let run = context.active;
    if !eligible(access, run) {
        return Err(forbidden());
    }
    let mut question = validate(args)?;
    let id = format!("question-{}", run.root_run_id);
    let mut tx = store.begin().await?;
    let mut chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, &run.conversation_id)
        .await?
        .ok_or_else(unavailable)?;
    if !chat["agentIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == &run.agent_id))
        || !WorkspaceStore::get_in(&mut tx, Table::Agents, &run.agent_id)
            .await?
            .is_some_and(|bot| bot.get("sharedBot").is_none())
    {
        return Err(forbidden());
    }
    let input = WorkspaceStore::get_in(&mut tx, Table::Messages, &run.requester_message_id)
        .await?
        .ok_or_else(forbidden)?;
    if input["role"] != "user"
        || input["userId"] != access.user_id()
        || input["conversationId"] != run.conversation_id
        || !super::mentions::delivered_to(&input, &run.agent_id, &run.root_run_id)
        || !threads::belongs(&input, run.thread_root_id.as_deref())
        || [
            "routineRun",
            "routineOperation",
            "memoryImport",
            "primaryCheckIn",
            "voiceCallId",
            "requestVoiceMemo",
        ]
        .iter()
        .any(|key| input["metadata"].get(key).is_some())
    {
        return Err(forbidden());
    }
    if let Some(thread) = &run.thread_root_id {
        threads::root(&mut tx, &run.conversation_id, thread).await?;
    }
    let existing = WorkspaceStore::get_in(&mut tx, Table::Messages, &id).await?;
    let mut created = None;
    if let Some(prior) = existing {
        let old = &prior["metadata"]["question"];
        if prior["kind"] != "question"
            || prior["agentId"] != run.agent_id
            || old["requester"]["userId"] != access.user_id()
            || ["question", "mode", "options", "version"]
                .iter()
                .any(|key| old[key] != question[key])
        {
            return Err(error(409, "QUESTION_LIMIT", "每轮只能提出一个问题。"));
        }
    } else {
        question["status"] = json!("pending");
        question["requester"] =
            json!({"userId":access.user_id(),"messageId":run.requester_message_id});
        question["runId"] = json!(run.root_run_id);
        let stamp = iso(now());
        let mut message = json!({"id":id,"conversationId":run.conversation_id,"agentId":run.agent_id,"role":"assistant","kind":"question","content":question["question"],"status":"done","createdAt":stamp,"metadata":{"question":question}});
        threads::stamp(&mut message, run.thread_root_id.as_deref());
        super::question_context::original_request(&mut tx, &message).await?;
        WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
        chat["updatedAt"] = json!(stamp);
        WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
        created = Some(message);
    }
    access.authorize(state).await?;
    run.family.authorize(state).await?;
    check_fence(run, context.generation)?;
    tx.commit().await?;
    if let Some(message) = created {
        store.emit("message", message);
        store.emit("update", json!({}));
    }
    let result = json!({"messageId":id,"status":"pending","awaitingHumanSubmission":true,"instruction":"End this turn. Do not wait, poll, or assume an answer."});
    Ok(json!({"content":[{"type":"text","text":result.to_string()}],"details":result}))
}

pub(super) async fn answer(
    Extract(state): Extract<State>,
    Path((wid, mid)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    only_fields(&body, &["optionIds"]).map_err(|_| invalid())?;
    let selected = body["optionIds"]
        .as_array()
        .filter(|items| (1..=6).contains(&items.len()))
        .ok_or_else(invalid)?;
    let store = grant.store(&state).await?;
    let initial = store
        .get(Table::Messages, &mid)
        .await?
        .filter(|m| m["kind"] == "question")
        .ok_or_else(unavailable)?;
    let cid = initial["conversationId"]
        .as_str()
        .ok_or_else(unavailable)?
        .to_owned();
    let key = AgentRegistry::key(&wid, &cid);
    let admission = state.agent_runs.admission(&wid).await?;
    let gate = state.agent_runs.queues.lock(&key).await;
    let mut tx = store.begin().await?;
    let mut card = WorkspaceStore::get_in(&mut tx, Table::Messages, &mid)
        .await?
        .filter(|m| m["kind"] == "question" && m["conversationId"] == cid)
        .ok_or_else(unavailable)?;
    let question = &card["metadata"]["question"];
    if question["requester"]["userId"] != grant.user_id {
        return Err(forbidden());
    }
    let options = question["options"].as_array().ok_or_else(unavailable)?;
    let unique: HashSet<&str> = selected
        .iter()
        .map(|id| id.as_str().ok_or_else(invalid))
        .collect::<Result<_>>()?;
    if unique.len() != selected.len()
        || (question["mode"] == "single" && unique.len() != 1)
        || selected
            .iter()
            .any(|id| !options.iter().any(|option| &option["id"] == id))
    {
        return Err(invalid());
    }
    let canonical: Vec<Value> = options
        .iter()
        .filter(|o| unique.contains(o["id"].as_str().unwrap_or("")))
        .map(|o| o["id"].clone())
        .collect();
    if question["status"] == "answered" {
        if question["answer"]["optionIds"] != json!(canonical) {
            return Err(error(
                409,
                "QUESTION_ALREADY_ANSWERED",
                "此问题已经提交了不同的回答。",
            ));
        }
        let message = WorkspaceStore::get_in(
            &mut tx,
            Table::Messages,
            question["answer"]["messageId"]
                .as_str()
                .ok_or_else(unavailable)?,
        )
        .await?
        .ok_or_else(unavailable)?;
        grant.authorize(&state).await?;
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"message":message,"question":card})),
        ));
    }
    if question["status"] != "pending" {
        return Err(unavailable());
    }
    super::question_context::original_request(&mut tx, &card).await?;
    let aid = card["agentId"].as_str().ok_or_else(unavailable)?.to_owned();
    let thread = card["threadRootId"].as_str().map(str::to_owned);
    let mut chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, &cid)
        .await?
        .ok_or_else(unavailable)?;
    let mut bot = WorkspaceStore::get_in(&mut tx, Table::Agents, &aid)
        .await?
        .filter(|bot| bot.get("sharedBot").is_none())
        .ok_or_else(unavailable)?;
    if !chat["agentIds"]
        .as_array()
        .is_some_and(|ids| ids.contains(&json!(aid)))
    {
        return Err(unavailable());
    }
    if let Some(thread) = &thread {
        threads::root(&mut tx, &cid, thread).await?;
    }
    let active = state.agent_runs.get(&key).await;
    if active
        .as_ref()
        .is_some_and(|run| run.cancelled.load(Ordering::Acquire))
    {
        return Err(unavailable());
    }
    if active.is_some() && state.agent_runs.queues.len(&key).await >= 20 {
        return Err(ApiError::new(429, "等待处理的消息已达20条。"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let authority = ExecutionAccess::User(grant.clone());
    let reservation = if active.is_none() {
        Some(
            Reservation::reserve_scoped(
                &state,
                &authority,
                &cid,
                &aid,
                &id,
                "user",
                thread.as_deref(),
            )
            .await?,
        )
    } else {
        None
    };
    let chosen = options
        .iter()
        .filter(|o| canonical.contains(&o["id"]))
        .map(|o| o["label"].as_str().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("; ");
    let content = format!(
        "Question answer: {}\nSelected: {}",
        question["question"].as_str().unwrap_or(""),
        chosen
    );
    let stamp = iso(now());
    let mut message = json!({"id":id,"conversationId":cid,"userId":grant.user_id,"role":"user","kind":"text","content":content,"createdAt":stamp,"delivery":{"state":"queued","mode":"followUp","agentId":aid,"explicitAgentId":aid,"clientId":format!("question-answer-{mid}"),"runId":reservation.as_ref().map(|r|&r.active.run_id)},"metadata":{"author":{"id":grant.user_id,"name":grant.user_name,"kind":"user"},"questionAnswer":{"questionId":mid,"optionIds":canonical}}});
    threads::stamp(&mut message, thread.as_deref());
    message["replyTo"] =
        json!(super::messages::reply(&mut tx, &cid, &json!(mid), thread.as_deref()).await?);
    card["metadata"]["question"]["status"] = json!("answered");
    card["metadata"]["question"]["answer"] =
        json!({"optionIds":canonical,"messageId":id,"submittedAt":stamp});
    WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
    WorkspaceStore::put_in(&mut tx, Table::Messages, &card).await?;
    chat["updatedAt"] = json!(stamp);
    WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
    if reservation.is_some() {
        bot["status"] = json!("working");
        WorkspaceStore::put_in(&mut tx, Table::Agents, &bot).await?;
    }
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("message", card.clone());
    store.emit("message", message.clone());
    store.emit("update", json!({}));
    let input = message.clone();
    // Dispatch is server-bound and never broadcasts to mentions found in labels.
    tokio::spawn(async move {
        let _gate = gate;
        let _admission = admission;
        if let Some(reservation) = reservation {
            reservation.launch(state, authority, store, input);
        } else {
            state
                .agent_runs
                .queues
                .push_user(&key, authority, input, None, false)
                .await;
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"message":message,"question":card})),
    ))
}
