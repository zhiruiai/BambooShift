use super::{connections, model, policy_data as data, store, tool_access};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields, text},
    scheduling::routines,
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;

pub async fn options(store: &WorkspaceStore, id: &str) -> Result<Value> {
    let connection = store::connection(store, id).await?;
    let mut choices = Vec::new();
    let mut conn = store.pool.acquire().await?;
    for routine in WorkspaceStore::list_in(&mut conn, Table::Routines).await? {
        if routine["enabled"] != true {
            continue;
        }
        if let Ok((agent, _)) = routines::target(
            &mut conn,
            routine["agentId"].as_str().unwrap_or(""),
            routine["conversationId"].as_str().unwrap_or(""),
        )
        .await
        {
            if agent.get("sharedBot").is_none() {
                choices.push(json!({"id":routine["id"],"title":routine["title"],"revision":model::hash(&routines::config(&routine)),"schedule":routine["schedule"],"timeZone":routine["timeZone"]}));
            }
        }
    }
    let tools = if connection.status == "connected" {
        connection.tools.iter().filter_map(|tool| {
            let name = tool["name"].as_str()?;
            tool_access::enabled(&connection, name).then(|| json!({
                "tool":tool,"revision":data::tool_revision(tool, tool_access::revision(&connection, name)),
                "eligible":data::read_only(tool)
            }))
        }).collect::<Vec<_>>()
    } else {
        vec![]
    };
    Ok(
        json!({"connectionId":id,"connectionRevision":connection.revision,"catalogRevision":data::catalog_revision(&connection),"routines":choices,"tools":tools}),
    )
}
pub async fn list(store: &WorkspaceStore, id: &str) -> Result<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT id FROM app_policies WHERE connection_id=? ORDER BY rowid DESC LIMIT 200",
    )
    .bind(id)
    .fetch_all(&store.pool)
    .await?;
    let mut conn = store.pool.acquire().await?;
    let mut result = vec![];
    for row in rows {
        if let Some(value) = data::get(&mut conn, row.get("id")).await? {
            result.push(data::public(value));
        }
    }
    Ok(result)
}
pub async fn create(
    state: &State,
    store: &Arc<WorkspaceStore>,
    actor: &WorkspaceAccess,
    id: &str,
    body: &Value,
) -> Result<Value> {
    only_fields(
        body,
        &[
            "requestId",
            "routineId",
            "expectedRoutineRevision",
            "connectionRevision",
            "catalogRevision",
            "toolName",
            "toolRevision",
            "arguments",
            "confirmReadOnly",
        ],
    )?;
    actor.authorize_owner(state).await?;
    let request = data::identifier(&body["requestId"])?;
    let digest = model::hash(body);
    let mut tx = store.begin().await?;
    if let Some(prior) = data::get(&mut tx, &request).await? {
        let saved: String = sqlx::query_scalar("SELECT digest FROM app_policies WHERE id=?")
            .bind(&request)
            .fetch_one(&mut *tx)
            .await?;
        if prior["issuerUserId"] != actor.user_id || prior["connectionId"] != id || saved != digest
        {
            return Err(data::conflict());
        }
        actor.authorize_owner(state).await?;
        return Ok(data::public(prior));
    }
    if sqlx::query_scalar::<_, i64>("SELECT 1 FROM app_policy_cancellations WHERE id=?")
        .bind(&request)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    {
        return Err(
            ApiError::new(409, "这次未接纳的授权已取消，请明确开始新的授权。")
                .with_code("APP_POLICY_CLOSED"),
        );
    }
    if body["confirmReadOnly"] != true {
        return Err(ApiError::bad("请明确确认你信任此工具只读取所选范围。"));
    }
    let routine_id = text(&body["routineId"], "例行任务", 160)?;
    let routine = WorkspaceStore::get_in(&mut tx, Table::Routines, &routine_id)
        .await?
        .ok_or_else(data::conflict)?;
    if routine["enabled"] != true
        || model::hash(&routines::config(&routine)) != body["expectedRoutineRevision"]
    {
        return Err(data::conflict());
    }
    let (agent, _) = routines::target(
        &mut tx,
        routine["agentId"].as_str().unwrap_or(""),
        routine["conversationId"].as_str().unwrap_or(""),
    )
    .await?;
    if agent.get("sharedBot").is_some() {
        return Err(ApiError::new(403, "共享来源 Bot 不使用这项个人预授权。"));
    }
    let connection = store::connection(store, id).await?;
    let tool_name = text(&body["toolName"], "工具", 128)?;
    let prepared = connections::prepare_call(store, id, &tool_name, &body["arguments"]).await?;
    let tool_revision =
        data::tool_revision(&prepared.tool, prepared.tool_access_revision.as_deref());
    if body["connectionRevision"] != connection.revision
        || body["catalogRevision"] != data::catalog_revision(&connection)
        || body["toolRevision"] != tool_revision
        || !tool_access::current(
            &connection,
            &tool_name,
            prepared.tool_access_revision.as_deref(),
        )
        || !data::read_only(&prepared.tool)
    {
        return Err(data::conflict());
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_policies WHERE status='active'")
        .fetch_one(&mut *tx)
        .await?;
    if count >= 100 {
        return Err(ApiError::new(
            409,
            "已达到 100 项有效应用预授权，请先撤销不再使用的授权。",
        ));
    }
    let value = json!({"id":request,"issuerUserId":actor.user_id,"routineId":routine_id,"routineTitle":routine["title"],"routineRevision":body["expectedRoutineRevision"],"routineConfig":routines::config(&routine),"connectionId":id,"connectionRevision":connection.revision,"sourceRevision":data::source_revision(&connection),"catalogRevision":data::catalog_revision(&connection),"toolName":tool_name,"toolRevision":tool_revision,"arguments":prepared.arguments,"status":"active","createdAt":iso(now())});
    sqlx::query("INSERT INTO app_policies VALUES(?,?,?,?,?,?,?)")
        .bind(&request)
        .bind(&actor.user_id)
        .bind(&routine_id)
        .bind(id)
        .bind("active")
        .bind(digest)
        .bind(value.to_string())
        .execute(&mut *tx)
        .await?;
    actor.authorize_owner(state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(data::public(value))
}
pub async fn revoke(
    state: &State,
    store: &WorkspaceStore,
    actor: &WorkspaceAccess,
    id: &str,
    policy: &str,
) -> Result<Value> {
    actor.authorize_owner(state).await?;
    let mut tx = store.begin().await?;
    let Some(mut value) = data::get(&mut tx, policy).await? else {
        data::identifier(&json!(policy))?;
        sqlx::query(
            "INSERT INTO app_policy_cancellations VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(policy)
        .bind(&actor.user_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let row =
            sqlx::query("SELECT issuer_id,connection_id FROM app_policy_cancellations WHERE id=?")
                .bind(policy)
                .fetch_one(&mut *tx)
                .await?;
        if row.get::<String, _>("issuer_id") != actor.user_id
            || row.get::<String, _>("connection_id") != id
        {
            return Err(data::conflict());
        }
        actor.authorize_owner(state).await?;
        tx.commit().await?;
        return Ok(json!({"id":policy,"status":"not_created"}));
    };
    if value["connectionId"] != id {
        return Err(ApiError::new(404, "应用授权不存在。"));
    }
    sqlx::query("UPDATE app_policies SET status='revoked' WHERE id=?")
        .bind(policy)
        .execute(&mut *tx)
        .await?;
    value["status"] = json!("revoked");
    actor.authorize_owner(state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(data::public(value))
}
