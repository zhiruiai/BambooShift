use super::model::{Connection, hash};
use crate::{
    error::{ApiError, Result},
    workspace::WorkspaceStore,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

pub async fn initialize(store: &WorkspaceStore) -> Result<()> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS app_policies(id TEXT PRIMARY KEY,issuer_id TEXT NOT NULL,routine_id TEXT NOT NULL,connection_id TEXT NOT NULL,status TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS app_policy_uses(run_id TEXT NOT NULL,call_key TEXT NOT NULL,action_id TEXT NOT NULL,PRIMARY KEY(run_id,call_key))",
        "CREATE TABLE IF NOT EXISTS app_policy_cancellations(id TEXT PRIMARY KEY,issuer_id TEXT NOT NULL,connection_id TEXT NOT NULL)",
    ] {
        sqlx::query(sql).execute(&store.pool).await?;
    }
    let changes = [
        "agentId",
        "conversationId",
        "title",
        "prompt",
        "schedule",
        "timeZone",
        "enabled",
    ]
    .iter()
    .map(|key| format!("json_extract(old.data,'$.{key}') IS NOT json_extract(new.data,'$.{key}')"))
    .collect::<Vec<_>>()
    .join(" OR ");
    let source = [
        "revision",
        "url",
        "authType",
        "authorization",
        "tools",
        "status",
    ]
    .iter()
    .map(|key| format!("json_extract(old.data,'$.{key}') IS NOT json_extract(new.data,'$.{key}')"))
    .collect::<Vec<_>>()
    .join(" OR ");
    for (table, field, condition) in [
        ("routines", "routine_id", changes),
        ("app_connections", "connection_id", source),
    ] {
        for (event, suffix) in [("UPDATE", "update"), ("DELETE", "delete")] {
            let when = if event == "UPDATE" {
                format!("WHEN {condition}")
            } else {
                String::new()
            };
            sqlx::query(&format!("CREATE TRIGGER IF NOT EXISTS app_policy_{table}_{suffix} AFTER {event} ON {table} {when} BEGIN UPDATE app_policies SET status='invalidated' WHERE {field}=old.id AND status='active'; END"))
                .execute(&store.pool).await?;
        }
    }
    // A separate trigger also upgrades existing databases without replacing their policy triggers.
    sqlx::query(
        "CREATE TRIGGER IF NOT EXISTS app_policy_routine_public_search_update
        AFTER UPDATE ON routines WHEN json_extract(old.data,'$.publicSearchQueries')
          IS NOT json_extract(new.data,'$.publicSearchQueries') BEGIN
          UPDATE app_policies SET status='invalidated' WHERE routine_id=old.id AND status='active';
        END",
    )
    .execute(&store.pool)
    .await?;
    Ok(())
}
pub fn read_only(tool: &Value) -> bool {
    tool["annotations"]["readOnlyHint"] == true && tool["annotations"]["destructiveHint"] != true
}
pub fn source_revision(connection: &Connection) -> String {
    hash(
        &json!({"url":connection.url,"authType":connection.auth_type,"authorization":connection.authorization}),
    )
}
pub fn catalog_revision(connection: &Connection) -> String {
    hash(&json!(connection.tools))
}
pub fn tool_revision(tool: &Value, access_revision: Option<&str>) -> String {
    let raw = hash(tool);
    match access_revision {
        Some(revision) => hash(&json!([raw, revision])),
        None => raw,
    }
}
pub(super) async fn invalidate_tool(
    conn: &mut SqliteConnection,
    connection_id: &str,
    tool_name: &str,
) -> Result<()> {
    for table in ["app_policies", "app_interactive_rules"] {
        sqlx::query(&format!(
            "UPDATE {table} SET status='invalidated'
             WHERE connection_id=? AND status='active' AND json_extract(data,'$.toolName')=?"
        ))
        .bind(connection_id)
        .bind(tool_name)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}
pub fn identifier(value: &Value) -> Result<String> {
    value
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok_and(|id| id.to_string() == *s))
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad("授权标识无效。"))
}
pub fn conflict() -> ApiError {
    ApiError::new(409, "任务或应用工具已变化，请重新读取并确认授权范围。")
        .with_code("APP_POLICY_CHANGED")
}
pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT status,data FROM app_policies WHERE id=?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(|row| {
        let mut value: Value = serde_json::from_str(row.get("data")).map_err(|_| conflict())?;
        value["status"] = json!(row.get::<String, _>("status"));
        Ok(value)
    })
    .transpose()
}
pub fn public(mut value: Value) -> Value {
    for key in ["sourceRevision", "routineConfig", "catalogRevision"] {
        value.as_object_mut().unwrap().remove(key);
    }
    value
}
