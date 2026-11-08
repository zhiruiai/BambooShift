use super::routines;
use crate::{
    agent::{ActiveRun, authority::ExecutionAccess},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore, mutations},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::collections::HashSet;

pub(crate) const QUERIES: &str = "publicSearchQueries";
const MAX_QUERIES: usize = 4;
const MAX_QUERY_LENGTH: usize = 160;

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS routine_public_search_grants (
        routine_id TEXT PRIMARY KEY, issuer_id TEXT NOT NULL, revision TEXT NOT NULL)",
    )
    .execute(&mut *conn)
    .await?;
    let changed = routines::CONFIG_FIELDS
        .iter()
        .map(|key| {
            format!("json_extract(old.data,'$.{key}') IS NOT json_extract(new.data,'$.{key}')")
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    sqlx::query(&format!("CREATE TRIGGER IF NOT EXISTS routine_public_search_changed
        AFTER UPDATE ON routines WHEN {changed} BEGIN
          DELETE FROM routine_public_search_grants WHERE routine_id=old.id AND (
            json_extract(new.data,'$.{QUERIES}') IS NULL OR
            json_extract(old.data,'$.agentId') IS NOT json_extract(new.data,'$.agentId') OR
            json_extract(old.data,'$.conversationId') IS NOT json_extract(new.data,'$.conversationId')
          );
          UPDATE routine_public_search_grants SET revision=lower(hex(randomblob(16)))
          WHERE routine_id=old.id;
        END")).execute(&mut *conn).await?;
    sqlx::query(
        "CREATE TRIGGER IF NOT EXISTS routine_public_search_removed
        AFTER DELETE ON routines BEGIN
          DELETE FROM routine_public_search_grants WHERE routine_id=old.id;
        END",
    )
    .execute(conn)
    .await?;
    Ok(())
}

fn invalid() -> ApiError {
    ApiError::bad("请填写 1 到 4 条不同的公开查询，每条最多 160 个字符。")
        .with_code("ROUTINE_SEARCH_INVALID")
}

pub(super) fn changed() -> ApiError {
    ApiError::new(409, "例行任务的搜索授权已变化，请刷新后重新确认。")
        .with_code("ROUTINE_SEARCH_SCOPE_CHANGED")
}

fn queries(value: &Value) -> Result<Vec<String>> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= MAX_QUERIES)
        .ok_or_else(invalid)?;
    let mut seen = HashSet::new();
    rows.iter()
        .map(|row| {
            let query = row
                .as_str()
                .map(str::trim)
                .filter(|query| {
                    !query.is_empty()
                        && query.encode_utf16().count() <= MAX_QUERY_LENGTH
                        && !query.chars().any(char::is_control)
                })
                .ok_or_else(invalid)?;
            if !seen.insert(query) {
                return Err(invalid());
            }
            Ok(query.to_owned())
        })
        .collect()
}

async fn direct(conn: &mut SqliteConnection, routine: &Value) -> Result<bool> {
    let Some(agent) = routine["agentId"].as_str() else {
        return Ok(false);
    };
    let Some(chat) = routine["conversationId"].as_str() else {
        return Ok(false);
    };
    let Some(agent_record) = WorkspaceStore::get_in(conn, Table::Agents, agent).await? else {
        return Ok(false);
    };
    let Some(chat_record) = WorkspaceStore::get_in(conn, Table::Conversations, chat).await? else {
        return Ok(false);
    };
    Ok(mutations::local(&agent_record).is_ok()
        && chat_record["isGroup"] == false
        && chat_record["agentIds"] == json!([agent]))
}

pub(super) fn clear(routine: &mut Value) {
    if let Some(fields) = routine.as_object_mut() {
        fields.remove(QUERIES);
    }
}

pub(super) async fn apply(
    conn: &mut SqliteConnection,
    routine: &mut Value,
    value: &Value,
) -> Result<()> {
    let approved = queries(value)?;
    if approved.is_empty() {
        clear(routine);
    } else {
        if !direct(conn, routine).await? {
            return Err(
                ApiError::new(409, "公开网页搜索授权只适用于本地 Bot 的单聊例行任务。")
                    .with_code("ROUTINE_SEARCH_TARGET"),
            );
        }
        routine[QUERIES] = json!(approved);
    }
    Ok(())
}

pub(super) async fn write_grant(
    conn: &mut SqliteConnection,
    routine: &Value,
    owner: &str,
) -> Result<()> {
    let id = routine["id"].as_str().ok_or_else(changed)?;
    if routine.get(QUERIES).is_some() {
        sqlx::query("INSERT INTO routine_public_search_grants VALUES (?,?,?)
            ON CONFLICT(routine_id) DO UPDATE SET issuer_id=excluded.issuer_id, revision=excluded.revision")
            .bind(id).bind(owner).bind(uuid::Uuid::new_v4().to_string()).execute(conn).await?;
    } else {
        sqlx::query("DELETE FROM routine_public_search_grants WHERE routine_id=?")
            .bind(id)
            .execute(conn)
            .await?;
    }
    Ok(())
}

async fn revision(
    conn: &mut SqliteConnection,
    routine_id: &str,
    issuer: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT revision FROM routine_public_search_grants WHERE routine_id=? AND issuer_id=?",
    )
    .bind(routine_id)
    .bind(issuer)
    .fetch_optional(conn)
    .await?)
}

fn admitted_actor(access: &ExecutionAccess, scheduled: bool) -> bool {
    match (access, scheduled) {
        (ExecutionAccess::User(actor), false) => actor.is_owner,
        (ExecutionAccess::Background(actor), true) => actor.primary_revision.is_none(),
        _ => false,
    }
}

pub(super) async fn admitted_revision(
    conn: &mut SqliteConnection,
    routine: &Value,
    access: &ExecutionAccess,
    scheduled: bool,
) -> Result<Option<String>> {
    let Some(id) = routine["id"].as_str() else {
        return Ok(None);
    };
    if !admitted_actor(access, scheduled)
        || (scheduled && routine["enabled"] != true)
        || queries(&routine[QUERIES]).map_or(true, |queries| queries.is_empty())
        || !direct(conn, routine).await?
    {
        return Ok(None);
    }
    revision(conn, id, access.user_id()).await
}

pub(crate) struct Grant {
    pub(crate) queries: Vec<String>,
    routine_id: String,
    issuer: String,
    revision: String,
    config: Value,
}

impl Grant {
    async fn current(&self, conn: &mut SqliteConnection) -> Result<bool> {
        let actual = revision(conn, &self.routine_id, &self.issuer).await?;
        if actual.as_deref() != Some(self.revision.as_str()) {
            return Ok(false);
        }
        let Some(routine) = WorkspaceStore::get_in(conn, Table::Routines, &self.routine_id).await?
        else {
            return Ok(false);
        };
        Ok(routines::config(&routine) == self.config && direct(conn, &routine).await?)
    }

    pub(crate) async fn authorize(&self, store: &WorkspaceStore) -> Result<()> {
        let mut tx = store.pool.begin().await?;
        if !self.current(&mut tx).await? {
            return Err(changed());
        }
        tx.commit().await?;
        Ok(())
    }
}

pub(crate) async fn capture(
    store: &WorkspaceStore,
    access: &ExecutionAccess,
    active: &ActiveRun,
    input: &Value,
) -> Result<Option<Grant>> {
    let scheduled = active.background;
    let marker = &input["metadata"]["routineRun"];
    let Some(routine_id) = marker["routineId"].as_str() else {
        return Ok(None);
    };
    if active.kind != "routine"
        || active.depth != 0
        || active.run_id != active.root_run_id
        || active.thread_root_id.is_some()
        || active.message_id != active.requester_message_id
        || !admitted_actor(access, scheduled)
        || access.user_id() != active.user_id
        || input["id"] != active.message_id
        || marker["runId"] != active.message_id
        || marker["inputMessageId"] != active.message_id
        || input["delivery"]["runId"] != active.run_id
        || input["role"] != if scheduled { "system" } else { "user" }
        || (!scheduled && input["userId"] != active.user_id)
    {
        return Ok(None);
    }
    let mut tx = store.pool.begin().await?;
    let Some(raw) = sqlx::query_scalar::<_, String>(
        "SELECT data FROM routine_runs WHERE run_id=? AND routine_id=?",
    )
    .bind(&active.message_id)
    .bind(routine_id)
    .fetch_optional(&mut *tx)
    .await?
    else {
        return Ok(None);
    };
    let run: Value = serde_json::from_str(&raw).map_err(|_| changed())?;
    let Some(revision) = run["publicSearchGrant"].as_str() else {
        return Ok(None);
    };
    if run["status"] != "running"
        || run["inputMessageId"] != active.message_id
        || run["agentId"] != active.agent_id
        || run["conversationId"] != active.conversation_id
        || run["trigger"] != if scheduled { "scheduled" } else { "manual" }
    {
        return Ok(None);
    }
    let config = run["routineConfig"].clone();
    let approved = queries(&config[QUERIES]).unwrap_or_default();
    if approved.is_empty()
        || config["agentId"] != active.agent_id
        || config["conversationId"] != active.conversation_id
        || (scheduled && config["enabled"] != true)
    {
        return Ok(None);
    }
    let grant = Grant {
        queries: approved,
        routine_id: routine_id.into(),
        issuer: access.user_id().into(),
        revision: revision.into(),
        config,
    };
    let current = grant.current(&mut tx).await?;
    tx.commit().await?;
    Ok(current.then_some(grant))
}
