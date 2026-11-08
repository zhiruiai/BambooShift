use super::config;
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields},
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json, Router,
    extract::{Path, State as Extract},
    http::HeaderMap,
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use uuid::{Uuid, Version};

const IDLE_MS: i64 = 15 * 60 * 1000;
const MAX_MS: i64 = 60 * 60 * 1000;

pub(crate) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS voice_calls (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
          started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER
        )",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_open_actor ON voice_calls(user_id) WHERE ended_at IS NULL")
        .execute(conn)
        .await?;
    Ok(())
}

pub(super) fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/workspaces/{wid}/conversations/{cid}/voice-calls",
            post(start).get(current),
        )
        .route(
            "/api/workspaces/{wid}/conversations/{cid}/voice-calls/{id}",
            get(read),
        )
        .route(
            "/api/workspaces/{wid}/conversations/{cid}/voice-calls/{id}/end",
            post(end),
        )
}

pub(crate) fn invalid() -> ApiError {
    ApiError::bad("语音通话请求无效。").with_code("VOICE_CALL_INVALID")
}
fn missing() -> ApiError {
    ApiError::new(404, "语音通话不存在或已不可用。").with_code("VOICE_CALL_NOT_FOUND")
}
fn unavailable() -> ApiError {
    ApiError::new(409, "请在一位 Bot 的单聊中开始语音通话。").with_code("VOICE_CALL_UNAVAILABLE")
}
pub(crate) fn busy() -> ApiError {
    ApiError::new(409, "当前会话正在处理任务，请等 Bot 完成后继续。").with_code("VOICE_CALL_BUSY")
}
pub(crate) fn id(value: &str) -> Result<&str> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| id.get_version() == Some(Version::Random) && id.to_string() == value)
        .map(|_| value)
        .ok_or_else(invalid)
}
pub(crate) fn requested(value: Option<&Value>) -> Result<Option<&str>> {
    value
        .map(|value| id(value.as_str().ok_or_else(invalid)?))
        .transpose()
}

struct Call {
    id: String,
    conversation_id: String,
    agent_id: String,
    user_id: String,
    started_at: i64,
    expires_at: i64,
    ended_at: Option<i64>,
}
impl Call {
    fn from_row(row: sqlx::sqlite::SqliteRow) -> Self {
        Self {
            id: row.get("id"),
            conversation_id: row.get("conversation_id"),
            agent_id: row.get("agent_id"),
            user_id: row.get("user_id"),
            started_at: row.get("started_at"),
            expires_at: row.get("expires_at"),
            ended_at: row.get("ended_at"),
        }
    }
    fn value(&self) -> Value {
        let mut call = json!({
            "id": self.id, "conversationId": self.conversation_id, "agentId": self.agent_id,
            "userId": self.user_id, "startedAt": iso(self.started_at), "expiresAt": iso(self.expires_at)
        });
        if let Some(ended) = self.ended_at {
            call["endedAt"] = json!(iso(ended));
        }
        call
    }
    async fn close(&mut self, conn: &mut SqliteConnection, stamp: i64) -> Result<Option<Value>> {
        if self.ended_at.is_some() {
            return Ok(None);
        }
        let ended = stamp.clamp(self.started_at, self.expires_at);
        sqlx::query("UPDATE voice_calls SET ended_at=? WHERE id=?")
            .bind(ended)
            .bind(&self.id)
            .execute(&mut *conn)
            .await?;
        self.ended_at = Some(ended);
        let submitted: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE json_extract(data,'$.conversationId')=?
             AND json_extract(data,'$.userId')=? AND json_extract(data,'$.role')='user'
             AND json_extract(data,'$.metadata.voiceCallId')=?)",
        )
        .bind(&self.conversation_id)
        .bind(&self.user_id)
        .bind(&self.id)
        .fetch_one(&mut *conn)
        .await?;
        if !submitted {
            return Ok(None);
        }
        let message = json!({
            "id": Uuid::new_v4().to_string(), "conversationId": self.conversation_id,
            "role": "system", "userId": self.user_id, "agentId": self.agent_id,
            "kind": "voice_call", "content": "", "createdAt": iso(stamp),
            "metadata": {"voiceCall": {"id": self.id, "startedAt": iso(self.started_at),
                "endedAt": iso(ended), "durationMs": ended - self.started_at}}
        });
        WorkspaceStore::put_in(conn, Table::Messages, &message).await?;
        Ok(Some(message))
    }
}

async fn find(conn: &mut SqliteConnection, user: &str, cid: &str, id: &str) -> Result<Call> {
    sqlx::query("SELECT * FROM voice_calls WHERE id=? AND conversation_id=? AND user_id=?")
        .bind(id)
        .bind(cid)
        .bind(user)
        .fetch_optional(conn)
        .await?
        .map(Call::from_row)
        .ok_or_else(missing)
}
async fn find_open(conn: &mut SqliteConnection, user: &str) -> Result<Option<Call>> {
    Ok(
        sqlx::query("SELECT * FROM voice_calls WHERE user_id=? AND ended_at IS NULL")
            .bind(user)
            .fetch_optional(conn)
            .await?
            .map(Call::from_row),
    )
}
fn agent(chat: &Value) -> Result<&str> {
    chat["agentIds"]
        .as_array()
        .filter(|ids| ids.len() == 1 && chat["isGroup"] != true && chat["demo"] != true)
        .and_then(|ids| ids[0].as_str())
        .ok_or_else(unavailable)
}
fn emit_card(store: &WorkspaceStore, message: Option<Value>) {
    if let Some(message) = message {
        store.emit("message", message);
        store.emit("update", json!({}));
    }
}

async fn start(
    Extract(state): Extract<State>,
    Path((wid, cid)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    only_fields(&body, &["id", "replaceId"])?;
    let id = requested(body.get("id"))?.ok_or_else(invalid)?;
    let replace = requested(body.get("replaceId"))?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let stamp = now();
    if let Some(mut existing) = sqlx::query("SELECT * FROM voice_calls WHERE id=?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .map(Call::from_row)
    {
        if existing.user_id != grant.user_id || existing.conversation_id != cid {
            return Err(missing());
        }
        let card = if stamp >= existing.expires_at {
            existing.close(&mut tx, stamp).await?
        } else {
            None
        };
        grant.authorize(&state).await?;
        tx.commit().await?;
        emit_card(&store, card);
        return Ok(Json(json!({"call":existing.value()})));
    }
    config::read(&state.config.data_dir)?.voice_model()?;
    let chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, &cid)
        .await?
        .ok_or_else(missing)?;
    let agent_id = agent(&chat)?.to_owned();
    let bot = WorkspaceStore::get_in(&mut tx, Table::Agents, &agent_id)
        .await?
        .ok_or_else(unavailable)?;
    if bot.get("sharedBot").is_some() {
        crate::shared_bots::resolve(&state, &grant, &agent_id).await?;
    }
    let card = if let Some(mut prior) = find_open(&mut tx, &grant.user_id).await? {
        if stamp < prior.expires_at && replace != Some(prior.id.as_str()) {
            return Err(ApiError::new(409, "请先结束你在此工作空间中的语音通话。")
                .with_code("VOICE_CALL_ACTIVE"));
        }
        prior.close(&mut tx, stamp).await?
    } else {
        None
    };
    let call = Call {
        id: id.to_owned(),
        conversation_id: cid,
        agent_id,
        user_id: grant.user_id.clone(),
        started_at: stamp,
        expires_at: stamp + IDLE_MS,
        ended_at: None,
    };
    sqlx::query("INSERT INTO voice_calls(id,conversation_id,user_id,agent_id,started_at,expires_at) VALUES(?,?,?,?,?,?)")
        .bind(&call.id).bind(&call.conversation_id).bind(&call.user_id).bind(&call.agent_id)
        .bind(call.started_at).bind(call.expires_at).execute(&mut *tx).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    emit_card(&store, card);
    Ok(Json(json!({"call":call.value()})))
}

async fn current(
    Extract(state): Extract<State>,
    Path((wid, cid)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, false).await?;
    let store = grant.store(&state).await?;
    let mut conn = store.pool.acquire().await?;
    WorkspaceStore::get_in(&mut conn, Table::Conversations, &cid)
        .await?
        .ok_or_else(missing)?;
    let open = find_open(&mut conn, &grant.user_id).await?;
    grant.authorize(&state).await?;
    Ok(Json(
        json!({"call":open.filter(|call| call.expires_at > now()).map(|call| call.value())}),
    ))
}

async fn read(
    Extract(state): Extract<State>,
    Path((wid, cid, call_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, false).await?;
    let store = grant.store(&state).await?;
    let mut conn = store.pool.acquire().await?;
    let mut call = find(&mut conn, &grant.user_id, &cid, id(&call_id)?).await?;
    if call.ended_at.is_none() && now() >= call.expires_at {
        call.ended_at = Some(call.expires_at);
    }
    grant.authorize(&state).await?;
    Ok(Json(json!({"call":call.value()})))
}
async fn end(
    Extract(state): Extract<State>,
    Path((wid, cid, call_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &[])?;
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let mut call = find(&mut tx, &grant.user_id, &cid, id(&call_id)?).await?;
    let card = call.close(&mut tx, now()).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    emit_card(&store, card);
    Ok(Json(json!({"call":call.value()})))
}

/// Validate and renew the call inside the same transaction as its accepted user turn.
pub(crate) async fn accept_turn(
    conn: &mut SqliteConnection,
    user: &str,
    cid: &str,
    call_id: &str,
    chat: &Value,
) -> Result<String> {
    let call = find(conn, user, cid, call_id).await?;
    let stamp = now();
    active(&call, stamp)?;
    if agent(chat)? != call.agent_id {
        return Err(unavailable());
    }
    sqlx::query("UPDATE voice_calls SET expires_at=? WHERE id=?")
        .bind(
            (stamp + IDLE_MS)
                .min(call.started_at + MAX_MS)
                .max(call.expires_at),
        )
        .bind(call_id)
        .execute(conn)
        .await?;
    Ok(call.agent_id)
}

fn active(call: &Call, stamp: i64) -> Result<()> {
    if call.ended_at.is_some() || call.expires_at <= stamp {
        return Err(
            ApiError::new(409, "语音通话已结束，请重新开始。").with_code("VOICE_CALL_ENDED")
        );
    }
    Ok(())
}

pub(super) async fn check_audio(
    state: &State,
    grant: &access::WorkspaceAccess,
    call_id: &str,
) -> Result<()> {
    let store = grant.store(state).await?;
    let mut conn = store.pool.acquire().await?;
    let call = sqlx::query("SELECT * FROM voice_calls WHERE id=? AND user_id=?")
        .bind(id(call_id)?)
        .bind(&grant.user_id)
        .fetch_optional(&mut *conn)
        .await?
        .map(Call::from_row)
        .ok_or_else(missing)?;
    active(&call, now())?;
    let chat = WorkspaceStore::get_in(&mut conn, Table::Conversations, &call.conversation_id)
        .await?
        .ok_or_else(missing)?;
    if agent(&chat)? != call.agent_id {
        return Err(unavailable());
    }
    grant.authorize(state).await
}
