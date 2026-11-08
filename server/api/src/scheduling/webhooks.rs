use super::{
    execution, routines,
    webhook_store::{self as keys, Delivery, Key},
};
use crate::{
    agent::{
        admission::Reservation,
        authority::{BackgroundAccess, ExecutionAccess},
    },
    db::{State, now},
    error::{ApiError, Body, Result, only_fields},
    password,
    workspace::{Table, WorkspaceStore, access, model},
};
use axum::{
    Json, Router,
    body::{Body as HttpBody, to_bytes},
    extract::{Path, Request, State as Extract},
    http::{HeaderMap, StatusCode, header},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{Sqlite, SqliteConnection, Transaction};

const MAX_BODY: usize = 8 * 1024;

pub(super) fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/workspaces/{wid}/routines/{id}/webhook",
            get(get_key).put(rotate).delete(revoke),
        )
        .route("/api/routine-webhooks/{wid}/{id}", post(accept))
}

fn canonical_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|value| value.hyphenated().to_string() == id)
}

fn safe_routine_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

pub(crate) fn is_webhook_ingress(path: &str) -> bool {
    path.strip_prefix("/api/routine-webhooks/")
        .and_then(|path| path.split_once('/'))
        .is_some_and(|(wid, id)| canonical_uuid(wid) && safe_routine_id(id))
}

pub(super) fn unauthorized() -> ApiError {
    ApiError::new(401, "Webhook 密钥无效或已失效。").with_code("ROUTINE_WEBHOOK_UNAUTHORIZED")
}

fn changed() -> ApiError {
    ApiError::new(409, "Webhook 设置已变化，请刷新后重试。").with_code("ROUTINE_WEBHOOK_CHANGED")
}

fn invalid_payload() -> ApiError {
    ApiError::bad("Webhook 正文必须是 JSON 对象。").with_code("ROUTINE_WEBHOOK_BODY")
}

fn target_ids(routine: &Value) -> Result<(&str, &str)> {
    let invalid = || {
        ApiError::new(409, "Webhook 仅适用于本地 Bot 的单人会话。")
            .with_code("ROUTINE_WEBHOOK_TARGET")
    };
    Ok((
        routine["agentId"].as_str().ok_or_else(invalid)?,
        routine["conversationId"].as_str().ok_or_else(invalid)?,
    ))
}

async fn read_routine(conn: &mut SqliteConnection, id: &str) -> Result<Value> {
    if !safe_routine_id(id) {
        return Err(ApiError::bad("例行任务标识无效。"));
    }
    WorkspaceStore::get_in(conn, Table::Routines, id)
        .await?
        .ok_or_else(|| ApiError::new(404, "例行任务不存在。"))
}

fn view(wid: &str, id: &str, key: Option<&Key>, generation: &str, owner: &str) -> Value {
    let enabled = key.is_some_and(|key| {
        key.key_digest.is_some() && key.target_generation == generation && key.issuer_id == owner
    });
    let mut value =
        json!({"enabled":enabled,"revision":key.map_or("unset", |key| key.revision.as_str())});
    if enabled {
        value["path"] = json!(format!("/api/routine-webhooks/{wid}/{id}"));
    }
    value
}

async fn get_key(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let owner = access::require(&state, &headers, &wid, true, true).await?;
    let store = owner.store(&state).await?;
    let mut snapshot = store.pool.begin().await?;
    let routine = read_routine(&mut snapshot, &id).await?;
    let (agent, chat) = target_ids(&routine)?;
    routines::webhook_target(&mut snapshot, agent, chat).await?;
    let generation = keys::generation(&mut snapshot, &id).await?;
    let mut identity = state.pool.begin().await?;
    owner.authorize_in(&mut identity).await?;
    let key = keys::read(&mut identity, &wid, &id).await?;
    Ok(Json(view(
        &wid,
        &id,
        key.as_ref(),
        &generation,
        &owner.user_id,
    )))
}

async fn rotate(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    change_key(&state, &wid, &id, &headers, &body, true).await
}

async fn revoke(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    change_key(&state, &wid, &id, &headers, &body, false).await
}

async fn change_key(
    state: &State,
    wid: &str,
    id: &str,
    headers: &HeaderMap,
    body: &Value,
    enable: bool,
) -> Result<Json<Value>> {
    only_fields(body, &["expectedRevision"])?;
    let expected = body["expectedRevision"]
        .as_str()
        .filter(|revision| *revision == "unset" || canonical_uuid(revision))
        .ok_or_else(|| ApiError::bad("Webhook 版本无效。"))?;
    let owner = access::require(state, headers, wid, true, true).await?;
    let store = owner.store(state).await?;
    let mut workspace = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    let routine = read_routine(&mut workspace, id).await?;
    if enable {
        let (agent, chat) = target_ids(&routine)?;
        routines::webhook_target(&mut workspace, agent, chat).await?;
    }
    let generation = keys::generation(&mut workspace, id).await?;
    let mut identity = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    owner.authorize_in(&mut identity).await?;
    ensure_open(state)?;
    let previous = keys::read(&mut identity, wid, id).await?;
    if expected
        != previous
            .as_ref()
            .map_or("unset", |key| key.revision.as_str())
    {
        return Err(changed());
    }
    if !enable && previous.as_ref().is_none_or(|key| key.key_digest.is_none()) {
        return Ok(Json(view(
            wid,
            id,
            previous.as_ref(),
            &generation,
            &owner.user_id,
        )));
    }
    let secret = enable.then(password::token);
    let key = Key {
        issuer_id: owner.user_id,
        revision: uuid::Uuid::new_v4().to_string(),
        key_digest: secret.as_deref().map(password::digest),
        target_generation: generation,
    };
    keys::save(&mut identity, wid, id, &key).await?;
    tokio::spawn(async move {
        let committed = identity.commit().await;
        drop(workspace);
        committed
    })
    .await
    .map_err(|_| unavailable())??;
    let mut result = view(wid, id, Some(&key), &key.target_generation, &key.issuer_id);
    if let Some(secret) = secret {
        result["secret"] = json!(secret);
    }
    Ok(Json(result))
}

fn unavailable() -> ApiError {
    ApiError::new(503, "Webhook 暂时不可用，请稍后重试。")
}

fn ensure_open(state: &State) -> Result<()> {
    if state.is_closing() || state.agent_runs.is_closed() {
        return Err(unavailable());
    }
    Ok(())
}

fn header_value<'a>(
    headers: &'a HeaderMap,
    key: &str,
    error: fn() -> ApiError,
) -> Result<Option<&'a str>> {
    let values = headers.get_all(key);
    let mut values = values.iter();
    let first = values
        .next()
        .map(|value| value.to_str().map_err(|_| error()))
        .transpose()?;
    if values.next().is_some() {
        return Err(error());
    }
    Ok(first)
}

async fn payload(headers: &HeaderMap, body: HttpBody, token: &str) -> Result<(Delivery, Value)> {
    let invalid_id =
        || ApiError::bad("Webhook 投递标识无效。").with_code("ROUTINE_WEBHOOK_IDEMPOTENCY_KEY");
    let id = header_value(headers, "idempotency-key", invalid_id)?;
    if id.is_some_and(|value| {
        value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    }) {
        return Err(invalid_id());
    }
    if headers.contains_key(header::CONTENT_ENCODING) {
        return Err(invalid_payload());
    }
    let bytes = to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| ApiError::new(413, "请求内容过大。"))?;
    let event = if bytes.is_empty() {
        json!({})
    } else {
        let kind = header_value(headers, "content-type", invalid_payload)?;
        if !kind
            .and_then(|kind| kind.split(';').next())
            .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
        {
            return Err(invalid_payload());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid_payload())?;
        if !value.is_object() {
            return Err(invalid_payload());
        }
        value
    };
    Ok((Delivery::new(token, id, &bytes), event))
}

async fn identity_fence(
    state: &State,
    wid: &str,
    id: &str,
    token: &str,
    original: &Key,
) -> Result<Transaction<'static, Sqlite>> {
    let mut identity = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let current = keys::authenticate(&mut identity, wid, id, token).await?;
    if current.revision != original.revision || current.issuer_id != original.issuer_id {
        return Err(unauthorized());
    }
    ensure_open(state)?;
    Ok(identity)
}

fn receipt(run: &str, duplicate: bool) -> (StatusCode, Json<Value>) {
    (
        StatusCode::ACCEPTED,
        Json(json!({"runId":run,"duplicate":duplicate})),
    )
}

async fn accept(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let (parts, body) = request.into_parts();
    if !is_webhook_ingress(parts.uri.path())
        || parts.uri.query().is_some()
        || parts.headers.contains_key(header::COOKIE)
        || parts.headers.contains_key(header::ORIGIN)
    {
        return Err(unauthorized());
    }
    let token = header_value(&parts.headers, "authorization", unauthorized)?
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| password::valid_token(value))
        .ok_or_else(unauthorized)?;
    let original = keys::authenticate(&mut *state.pool.acquire().await?, &wid, &id, token).await?;
    let (delivery, payload) = payload(&parts.headers, body, token).await?;
    let background = BackgroundAccess::capture(&state, &wid, None).await?;
    if background.owner_id != original.issuer_id {
        return Err(unauthorized());
    }
    let store = state.workspace.get(&wid, &background.storage_key).await?;
    let grant = ExecutionAccess::Background(background.with_webhook_event(payload));
    // Admission precedes the workspace writer, matching operations that hold maintenance first.
    let admission = state.agent_runs.admission(&wid).await?;
    let credentials = store.credential_lock.lock().await;
    let mut workspace = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    let current_key =
        keys::authenticate(&mut *state.pool.acquire().await?, &wid, &id, token).await?;
    if current_key.revision != original.revision
        || keys::generation(&mut workspace, &id).await? != original.target_generation
    {
        return Err(unauthorized());
    }
    let current = WorkspaceStore::get_in(&mut workspace, Table::Routines, &id)
        .await?
        .ok_or_else(unauthorized)?;
    let (agent, chat) = target_ids(&current)?;
    routines::webhook_target(&mut workspace, agent, chat).await?;
    let at = now();
    if let Some(run) = delivery
        .previous(&mut workspace, &id, &original.revision, at)
        .await?
    {
        let _identity = identity_fence(&state, &wid, &id, token, &original).await?;
        return Ok(receipt(&run, true));
    }
    if current["enabled"] != true {
        return Err(ApiError::new(409, "此例行任务已暂停。").with_code("ROUTINE_WEBHOOK_PAUSED"));
    }
    keys::check_rate(&mut workspace, &id, at).await?;
    if !model::settings(&store, &mut workspace)
        .await
        .is_ok_and(|value| value["configured"] == true)
    {
        return Err(ApiError::new(503, "Webhook 任务需要已配置的模型。")
            .with_code("ROUTINE_WEBHOOK_MODEL_UNAVAILABLE"));
    }
    drop(credentials);
    let run = uuid::Uuid::new_v4().to_string();
    let reservation =
        Reservation::reserve_kind_admitted(&state, &grant, chat, agent, &run, "webhook", admission)
            .await?;
    let identity = identity_fence(&state, &wid, &id, token, &original).await?;
    let input = execution::persist_webhook(
        &mut workspace,
        &current,
        &grant,
        at,
        &run,
        &reservation.active.run_id,
    )
    .await?;
    delivery
        .insert(&mut workspace, &id, &original.revision, &run, at)
        .await?;
    // An accepted delivery and its launch survive disconnection of the HTTP sender.
    tokio::spawn(async move {
        workspace.commit().await?;
        drop(identity);
        store.emit("message", input.clone());
        store.emit("update", json!({}));
        reservation.launch(state, grant, store, input);
        Ok::<(), ApiError>(())
    })
    .await
    .map_err(|_| unavailable())??;
    Ok(receipt(&run, false))
}
