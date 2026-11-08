use super::{
    authority::ExecutionAccess,
    tools::{ToolContext, check_fence},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields, text},
    scheduling::routines,
    workspace::{Table, WorkspaceStore, time_zone},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::sync::Arc;

fn hash(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string()))
}
fn revision(value: &Value) -> String {
    hash(&json!({"id":value["id"],"config":routines::config(value)}))
}
fn conflict() -> ApiError {
    ApiError::new(409, "例行任务已变化，请先重新读取当前版本。").with_code("ROUTINE_CHANGED")
}
fn identifier(value: &Value) -> Result<String> {
    let value = value
        .as_str()
        .filter(|s| super::messages::opaque(s))
        .ok_or_else(|| ApiError::bad("例行任务标识无效。"))?;
    Ok(value.to_owned())
}
fn valid_text(value: &Value, label: &str, limit: usize) -> Result<String> {
    if value
        .as_str()
        .is_none_or(|s| s.contains('\0') || s.encode_utf16().count() > limit)
    {
        return Err(ApiError::bad(format!("{label}无效。")));
    }
    text(value, label, limit)
}
fn view(value: &Value, full: bool) -> Value {
    let prompt = value["prompt"].as_str().unwrap_or("");
    let display = if full {
        prompt.to_owned()
    } else {
        prompt.chars().take(256).collect()
    };
    let zone = time_zone::effective(value.get("timeZone"));
    let mut output = json!({"id":value["id"],"revision":revision(value),"conversationId":value["conversationId"],"title":value["title"],"schedule":value["schedule"],"timeZone":zone.as_deref().unwrap_or(""),"enabled":value["enabled"],"nextRunAt":value["nextRunAt"],"promptTruncated":display.len()<prompt.len(),"prompt":display});
    if let Some(last) = value.get("lastRunAt") {
        output["lastRunAt"] = last.clone();
    }
    if zone.is_err() {
        output["configurationError"] = json!("invalid_time_zone");
    }
    output
}
async fn authorize(
    state: &State,
    access: &ExecutionAccess,
    context: &ToolContext<'_>,
) -> Result<()> {
    let active = context.active;
    if active.kind != "user" || active.depth != 0 || active.background || access.as_user().is_none()
    {
        return Err(ApiError::new(
            403,
            "只有拥有者当前发起的聊天任务可以管理例行任务。",
        ));
    }
    check_fence(active, context.generation)?;
    access.authorize_owner(state).await?;
    active.family.authorize(state).await?;
    check_fence(active, context.generation)
}
async fn source(
    conn: &mut SqliteConnection,
    access: &ExecutionAccess,
    context: &ToolContext<'_>,
) -> Result<()> {
    let active = context.active;
    let input = WorkspaceStore::get_in(conn, Table::Messages, &active.requester_message_id)
        .await?
        .ok_or_else(|| ApiError::new(403, "原人工消息已不存在。"))?;
    let forbidden = ["memoryImport", "routineOperation", "routineRun"]
        .iter()
        .any(|k| input["metadata"].get(k).is_some());
    if input["role"] != "user"
        || input["userId"] != access.user_id()
        || input["conversationId"] != active.conversation_id
        || !super::mentions::delivered_to(&input, &active.agent_id, &active.root_run_id)
        || forbidden
    {
        return Err(ApiError::new(403, "例行任务的原人工授权已失效。"));
    }
    routines::target(conn, &active.agent_id, &active.conversation_id).await?;
    Ok(())
}
async fn target(conn: &mut SqliteConnection, id: &str, agent_id: &str) -> Result<Value> {
    let routine = WorkspaceStore::get_in(conn, Table::Routines, id)
        .await?
        .filter(|r| r["agentId"] == agent_id)
        .ok_or_else(|| ApiError::new(404, "此 Bot 的例行任务不存在。"))?;
    routines::target(
        conn,
        agent_id,
        routine["conversationId"].as_str().unwrap_or(""),
    )
    .await?;
    Ok(routine)
}
async fn prior(
    conn: &mut SqliteConnection,
    context: &ToolContext<'_>,
    binding: &str,
    digest: &str,
) -> Result<Option<Value>> {
    let row=sqlx::query("SELECT binding,digest,data FROM routine_tool_operations WHERE root_run_id=? AND tool_call_id=?")
        .bind(&context.active.root_run_id).bind(context.call_id).fetch_optional(conn).await?;
    let Some(row) = row else { return Ok(None) };
    if row.get::<String, _>("binding") != binding || row.get::<String, _>("digest") != digest {
        return Err(ApiError::new(409, "同一工具请求不能改用另一组参数。")
            .with_code("ROUTINE_TOOL_CALL_CONFLICT"));
    }
    Ok(Some(serde_json::from_str(row.get("data")).map_err(
        |_| ApiError::new(503, "任务操作回执暂不可用。"),
    )?))
}
pub(crate) async fn execute(
    state: &State,
    access: &ExecutionAccess,
    store: &Arc<WorkspaceStore>,
    context: &ToolContext<'_>,
    name: &str,
    args: &Value,
) -> Result<Value> {
    authorize(state, access, context).await?;
    if context.call_id.is_empty()
        || context.call_id.len() > 512
        || context.call_id.chars().any(char::is_control)
    {
        return Err(ApiError::bad("例行任务调用标识无效。"));
    }
    let mut tx = store.begin().await?;
    source(&mut tx, access, context).await?;
    let output = if name == "routine_list" {
        only_fields(args, &["routineId"])?;
        let values = if let Some(id) = args.get("routineId") {
            vec![target(&mut tx, &identifier(id)?, &context.active.agent_id).await?]
        } else {
            let mut values = Vec::new();
            for r in WorkspaceStore::list_in(&mut tx, Table::Routines).await? {
                if r["agentId"] == context.active.agent_id
                    && routines::target(
                        &mut tx,
                        &context.active.agent_id,
                        r["conversationId"].as_str().unwrap_or(""),
                    )
                    .await
                    .is_ok()
                {
                    values.push(r);
                }
            }
            values
        };
        let total = values.len();
        let mut selected = Vec::new();
        let mut bytes = 0;
        for value in values.iter().take(100) {
            let v = view(value, args.get("routineId").is_some());
            bytes += v.to_string().len();
            if bytes > 96 * 1024 {
                break;
            }
            selected.push(v);
        }
        json!({"operation":"list","defaultTimeZone":time_zone::read(&mut tx).await?["timeZone"],"total":total,"truncated":selected.len()<total,"routines":selected})
    } else {
        sqlx::query("CREATE TABLE IF NOT EXISTS routine_tool_operations(root_run_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,binding TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(root_run_id,tool_call_id))").execute(&mut *tx).await?;
        let binding = hash(
            &json!({"agentId":context.active.agent_id,"conversationId":context.active.conversation_id,"inputMessageId":context.active.requester_message_id,"userId":access.user_id()}),
        );
        let digest = hash(&json!({"name":name,"input":args}));
        if let Some(value) = prior(&mut tx, context, &binding, &digest).await? {
            authorize(state, access, context).await?;
            return Ok(
                json!({"content":[{"type":"text","text":value.to_string()}],"details":value}),
            );
        }
        let value = mutate(&mut tx, context, name, args).await?;
        sqlx::query("INSERT INTO routine_tool_operations VALUES(?,?,?,?,?)")
            .bind(&context.active.root_run_id)
            .bind(context.call_id)
            .bind(binding)
            .bind(digest)
            .bind(value.to_string())
            .execute(&mut *tx)
            .await?;
        value
    };
    source(&mut tx, access, context).await?;
    authorize(state, access, context).await?;
    tx.commit().await?;
    if name != "routine_list" {
        store.emit("update", json!({}));
    }
    Ok(json!({"content":[{"type":"text","text":output.to_string()}],"details":output}))
}
async fn mutate(
    conn: &mut SqliteConnection,
    context: &ToolContext<'_>,
    name: &str,
    args: &Value,
) -> Result<Value> {
    let at = now();
    let (routine, status, operation) = if name == "routine_create" {
        only_fields(
            args,
            &["title", "prompt", "schedule", "timeZone", "enabled"],
        )?;
        valid_text(&args["title"], "任务标题", 100)?;
        valid_text(&args["prompt"], "任务要求", 12000)?;
        valid_text(&args["schedule"], "执行频率", 80)?;
        let mut body = args.clone();
        body["agentId"] = json!(context.active.agent_id);
        body["conversationId"] = json!(context.active.conversation_id);
        (
            routines::validate(conn, &body, None, at).await?,
            "created",
            "create",
        )
    } else {
        let allowed = match name {
            "routine_update" => vec!["routineId", "expectedRevision", "changes"],
            "routine_pause" => vec!["routineId", "expectedRevision", "paused"],
            "routine_delete" => vec!["routineId", "expectedRevision"],
            _ => return Err(ApiError::new(403, "未授予此例行任务工具。")),
        };
        only_fields(args, &allowed)?;
        let old = target(
            conn,
            &identifier(&args["routineId"])?,
            &context.active.agent_id,
        )
        .await?;
        if args["expectedRevision"] != revision(&old) {
            return Err(conflict());
        }
        match name {
            "routine_update" => {
                let changes = &args["changes"];
                only_fields(changes, &["title", "prompt", "schedule", "timeZone"])?;
                if changes.as_object().unwrap().is_empty() {
                    return Err(ApiError::bad("请提供要修改的任务字段。"));
                }
                for (field, label, limit) in [
                    ("title", "任务标题", 100),
                    ("prompt", "任务要求", 12000),
                    ("schedule", "执行频率", 80),
                ] {
                    if let Some(value) = changes.get(field) {
                        valid_text(value, label, limit)?;
                    }
                }
                (
                    routines::validate(conn, changes, Some(&old), at).await?,
                    "updated",
                    "update",
                )
            }
            "routine_pause" => {
                let paused = args["paused"]
                    .as_bool()
                    .ok_or_else(|| ApiError::bad("请选择暂停或恢复。"))?;
                if paused {
                    (routines::pause(old), "paused", "pause")
                } else {
                    (
                        routines::validate(conn, &json!({"enabled":true}), Some(&old), at).await?,
                        "resumed",
                        "pause",
                    )
                }
            }
            _ => (old, "deleted", "delete"),
        }
    };
    if status == "deleted" {
        WorkspaceStore::delete_in(conn, Table::Routines, routine["id"].as_str().unwrap()).await?;
    } else {
        WorkspaceStore::put_in(conn, Table::Routines, &routine).await?;
    }
    let mut output = json!({"operation":operation,"operationId":uuid::Uuid::new_v4().to_string(),"routineId":routine["id"],"status":status,"appliedAt":iso(at),"notice":if status=="deleted" {"例行任务已删除；历史记录保留，已开始的任务不会因此停止。"}else{"计划已保存；本次没有立即执行任务。"}});
    if status != "deleted" {
        output["routine"] = view(&routine, true);
    }
    Ok(output)
}
