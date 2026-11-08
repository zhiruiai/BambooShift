use super::{authority::ExecutionAccess, mentions, registry::ActiveRun};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};

fn visible_text(message: &Value) -> bool {
    message["content"]
        .as_str()
        .is_some_and(|text| !text.trim().is_empty())
}

pub(super) async fn update_message(
    state: &State,
    grant: &ExecutionAccess,
    store: &WorkspaceStore,
    input: &Value,
    result: &mut Value,
    active: &ActiveRun,
    generation: u64,
    event: &Value,
) -> Result<()> {
    if !["message_start", "message_update", "message_end"]
        .contains(&event["type"].as_str().unwrap_or(""))
        || event["message"]["role"] != "assistant"
    {
        return Ok(());
    }
    if event["type"] == "message_start" {
        if result["metadata"]["modelMessageStarted"] == true {
            let visible = visible_text(result);
            if !visible || result["metadata"]["streamEnded"] != true {
                let mut tx = store.begin().await?;
                if visible {
                    result["metadata"]["streamEnded"] = json!(true);
                    preserve_message_fields(&mut tx, result).await?;
                    WorkspaceStore::put_in(&mut tx, Table::Messages, result).await?;
                } else {
                    WorkspaceStore::delete_in(
                        &mut tx,
                        Table::Messages,
                        result["id"].as_str().unwrap_or(""),
                    )
                    .await?;
                }
                grant.authorize(state).await?;
                active.family.authorize(state).await?;
                super::tools::check_fence(active, generation)?;
                tx.commit().await?;
                if visible {
                    store.emit("message", result.clone());
                } else {
                    store.emit("update", json!({}));
                }
            }
            let mut next = result.clone();
            next["id"] = json!(uuid::Uuid::new_v4().to_string());
            next["createdAt"] = json!(iso(now()));
            next["content"] = json!("");
            next["status"] = json!("running");
            for field in ["reactions", "reactionMembers", "replyTo"] {
                next.as_object_mut().unwrap().remove(field);
            }
            next["metadata"]
                .as_object_mut()
                .unwrap()
                .remove("streamEnded");
            // A continuation can call another tool without producing any visible text.
            *result = next;
        }
        result["metadata"]["modelMessageStarted"] = json!(true);
        result["metadata"]["inputGeneration"] = json!(generation);
    }
    let content = event["message"]["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default();
    let terminal = event["type"] == "message_end";
    let received = !content.trim().is_empty();
    if !received && !terminal {
        return Ok(());
    }
    if received {
        result["content"] = json!(content);
    }
    let ended = terminal && visible_text(result);
    if ended {
        // The model turn ended, but unread delivery waits for the run to settle.
        result["metadata"]["streamEnded"] = json!(true);
    }
    let publish = received || ended;
    let mut tx = store.begin().await?;
    if WorkspaceStore::get_in(
        &mut tx,
        Table::Conversations,
        input["conversationId"].as_str().unwrap_or(""),
    )
    .await?
    .is_some()
    {
        if publish {
            preserve_message_fields(&mut tx, result).await?;
            WorkspaceStore::put_in(&mut tx, Table::Messages, result).await?;
        }
        if terminal {
            super::usage::record(&mut tx, grant, active, result, event).await?;
        }
        grant.authorize(state).await?;
        active.family.authorize(state).await?;
        super::tools::authorize_membership(store, active).await?;
        super::tools::check_fence(active, generation)?;
        tx.commit().await?;
        if publish {
            store.emit("message", result.clone());
        }
    }
    Ok(())
}

pub(crate) async fn finalize(
    state: &State,
    grant: &ExecutionAccess,
    store: &WorkspaceStore,
    active: &ActiveRun,
    conversation_id: &str,
    result: &mut Value,
) -> Result<bool> {
    let mut tx = store.begin().await?;
    let mut updated_input = None;
    let present = WorkspaceStore::get_in(&mut tx, Table::Conversations, conversation_id)
        .await?
        .is_some();
    if present {
        preserve_message_fields(&mut tx, result).await?;
        WorkspaceStore::put_in(&mut tx, Table::Messages, result).await?;
        if let Some(input_id) = result["metadata"]["inputMessageId"].as_str() {
            if let Some(mut input) =
                WorkspaceStore::get_in(&mut tx, Table::Messages, input_id).await?
            {
                if input.get("mentions").is_none() && input["delivery"]["state"] == "queued" {
                    input["delivery"]["state"] = json!("interrupted");
                    input["delivery"]["reason"] = json!("任务未能开始，请核对执行结果后重试。");
                    WorkspaceStore::put_in(&mut tx, Table::Messages, &input).await?;
                }
            }
        }
    }
    if let Some(mut input) =
        WorkspaceStore::get_in(&mut tx, Table::Messages, &active.message_id).await?
    {
        if result["status"] == "done" {
            let authorized = async {
                grant.authorize(state).await?;
                active.family.authorize(state).await?;
                super::tools::authorize_membership(store, active).await?;
                super::tools::check_fence(
                    active,
                    active.generation.load(std::sync::atomic::Ordering::Acquire),
                )
            }
            .await;
            if let Err(error) = authorized {
                result["status"] = json!("error");
                result["metadata"]["executionStatus"] = json!(if error.status.as_u16() == 409 {
                    "cancelled"
                } else {
                    "interrupted"
                });
                let content = result["content"].as_str().unwrap_or("");
                result["content"] = json!(format!(
                    "{content}\n\n任务权限或要求已变化，此次未确认完成。"
                ));
                if present {
                    WorkspaceStore::put_in(&mut tx, Table::Messages, result).await?;
                }
            }
        }
        if input.get("mentions").is_some()
            && mentions::finish(&mut input, &active.agent_id, &active.run_id, result)
        {
            WorkspaceStore::put_in(&mut tx, Table::Messages, &input).await?;
            updated_input = Some(input.clone());
        }
        crate::scheduling::settle(&mut tx, &input, result).await?;
        crate::memory_imports::settle(&mut tx, &input, result).await?;
    }
    if let Some(mut agent) =
        WorkspaceStore::get_in(&mut tx, Table::Agents, &active.agent_id).await?
    {
        let other = state
            .agent_runs
            .agent_busy(grant.workspace_id(), &active.agent_id, Some(&active.run_id))
            .await;
        agent["status"] = json!(if other { "working" } else { "idle" });
        WorkspaceStore::put_in(&mut tx, Table::Agents, &agent).await?;
    }
    for mut previous in WorkspaceStore::list_in(&mut tx, Table::Messages).await? {
        if previous["id"] != result["id"]
            && previous["metadata"]["runId"] == active.run_id
            && previous["status"] == "running"
        {
            previous["status"] = result["status"].clone();
            WorkspaceStore::put_in(&mut tx, Table::Messages, &previous).await?;
        }
    }
    tx.commit().await?;
    if let Some(input) = updated_input {
        store.emit("message", input);
    }
    Ok(present)
}

async fn preserve_message_fields(
    conn: &mut sqlx::SqliteConnection,
    message: &mut Value,
) -> Result<()> {
    if let Some(current) =
        WorkspaceStore::get_in(conn, Table::Messages, message["id"].as_str().unwrap_or("")).await?
    {
        for field in ["reactions", "reactionMembers", "replyTo"] {
            if let Some(value) = current.get(field) {
                message[field] = value.clone();
            }
        }
    }
    Ok(())
}

pub(super) async fn begin_execution(
    state: &State,
    grant: &ExecutionAccess,
    store: &WorkspaceStore,
    input: &Value,
    result: &Value,
    active: &ActiveRun,
) -> Result<()> {
    let mut tx = store.begin().await?;
    let mut current =
        WorkspaceStore::get_in(&mut tx, Table::Messages, input["id"].as_str().unwrap_or(""))
            .await?
            .ok_or_else(|| ApiError::new(409, "原输入已不存在。"))?;
    let source_valid = if active.depth > 0 {
        current["role"] == "system"
            && current["agentId"] == active.agent_id
            && current["delivery"]["runId"] == active.run_id
            && current["metadata"]["delegation"]["rootRunId"] == active.root_run_id
    } else if grant.background() {
        current["role"] == "system"
    } else {
        current["userId"] == grant.user_id()
    };
    let ready = if current.get("mentions").is_some() {
        let chat =
            WorkspaceStore::get_in(&mut tx, Table::Conversations, &active.conversation_id).await?;
        source_valid
            && active.depth == 0
            && current["role"] == "user"
            && super::threads::belongs(&current, active.thread_root_id.as_deref())
            && chat.is_some_and(|chat| {
                chat["isGroup"] == true
                    && chat["agentIds"]
                        .as_array()
                        .is_some_and(|members| members.iter().any(|id| id == &active.agent_id))
            })
            && mentions::begin(&mut current, &active.agent_id, &active.run_id)
    } else if source_valid && current["delivery"]["state"] == "queued" {
        current["delivery"]["state"] = json!("delivered");
        true
    } else {
        false
    };
    if !ready {
        return Err(ApiError::new(409, "原任务输入已改变，未开始执行。"));
    }
    WorkspaceStore::put_in(&mut tx, Table::Messages, &current).await?;
    WorkspaceStore::put_in(&mut tx, Table::Messages, result).await?;
    grant.authorize(state).await?;
    active.family.authorize(state).await?;
    super::tools::check_fence(
        active,
        active.generation.load(std::sync::atomic::Ordering::Acquire),
    )?;
    tx.commit().await?;
    store.emit("message", current);
    store.emit("message", result.clone());
    Ok(())
}
