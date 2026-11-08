use super::store as ledger;
use crate::{
    agent::{AgentRegistry, admission::Reservation, authority::ExecutionAccess},
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields},
    workspace::{Table, WorkspaceAccess, WorkspaceStore, access, model, primary},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

async fn readiness_value(
    conn: &mut SqliteConnection,
    store: &WorkspaceStore,
    grant: &WorkspaceAccess,
) -> Result<Value> {
    let primary = primary::read(conn, &grant.kind).await?;
    let configured = model::settings(store, conn).await?["configured"] == true;
    let reason = if grant.kind != "personal" {
        Some("personal_required")
    } else if primary["agentId"].is_null() {
        Some("primary_required")
    } else if primary["conversationId"].is_null() {
        Some("primary_chat_missing")
    } else if !configured {
        Some("model_required")
    } else {
        None
    };
    let mut value =
        json!({"available":reason.is_none(),"primary":primary,"modelConfigured":configured});
    if let Some(reason) = reason {
        value["reason"] = json!(reason);
    };
    Ok(value)
}
pub async fn readiness(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let value = readiness_value(&mut *store.pool.acquire().await?, &store, &grant).await?;
    grant.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    ledger::request_id(&json!(id))?;
    let store = grant.store(&state).await?;
    let mut conn = store.pool.acquire().await?;
    let (_, receipt) = ledger::saved(&mut conn, &grant, &id)
        .await?
        .ok_or_else(|| {
            ApiError::new(404, "没有找到这次导入的提交记录。").with_code("MEMORY_IMPORT_NOT_FOUND")
        })?;
    let view = ledger::view(&mut conn, receipt).await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(view))
}
pub async fn submit(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let result = submit_owned(&state, &wid, &grant, &body).await;
    if let Err(error) = result {
        if [400, 409, 413, 422].contains(&error.status.as_u16())
            && !state.is_closing()
            && ledger::request_id(&body["requestId"]).is_ok()
        {
            grant.authorize_owner(&state).await?;
            let store = grant.store(&state).await?;
            let mut tx = store.begin().await?;
            let exists =
                sqlx::query("SELECT 1 FROM memory_imports WHERE actor_id=? AND request_id=?")
                    .bind(format!("user:{}", grant.user_id))
                    .bind(body["requestId"].as_str())
                    .fetch_optional(&mut *tx)
                    .await?
                    .is_some();
            grant.authorize_owner(&state).await?;
            tx.rollback().await?;
            if !exists {
                return Err(error.with_code("MEMORY_IMPORT_NOT_STARTED"));
            }
        }
        return Err(error);
    }
    result
}
async fn submit_owned(
    state: &State,
    wid: &str,
    grant: &WorkspaceAccess,
    body: &Value,
) -> Result<(StatusCode, Json<Value>)> {
    if state.is_closing() || state.agent_runs.is_closed() {
        return Err(ApiError::new(503, "服务正在关闭。"));
    }
    only_fields(&body, &["requestId", "expectedPrimaryRevision", "content"])?;
    let id = ledger::request_id(&body["requestId"])?;
    let revision = body["expectedPrimaryRevision"]
        .as_str()
        .ok_or_else(|| ApiError::bad("主 Bot 版本无效。"))?;
    if revision != "unset" {
        ledger::request_id(&json!(revision))?;
    }
    let source = body["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && !s.contains('\0'))
        .ok_or_else(|| ApiError::bad("请粘贴要整理的个人资料。"))?;
    if source.encode_utf16().count() > 16000 || source.len() > 65536 {
        return Err(ApiError::new(
            413,
            "导入内容最多 16000 字符且不能超过 64 KiB。",
        ));
    }
    let content = source.trim().to_owned();
    let digest = ledger::digest(revision, &content);
    let store = grant.store(&state).await?;
    {
        let mut conn = store.pool.acquire().await?;
        if let Some((old, receipt)) = ledger::saved(&mut conn, &grant, &id).await? {
            if old != digest {
                return Err(ApiError::new(409, "同一次导入不能用于不同资料或主 Bot。")
                    .with_code("MEMORY_IMPORT_REQUEST_CONFLICT"));
            }
            let view = ledger::view(&mut conn, receipt).await?;
            grant.authorize_owner(&state).await?;
            return Ok((StatusCode::OK, Json(view)));
        }
    }
    let ready = readiness_value(&mut *store.pool.acquire().await?, &store, &grant).await?;
    if ready["available"] != true {
        return Err(
            ApiError::new(409, "请先在个人空间选择主 Bot 并配置模型，再导入资料。")
                .with_code("MEMORY_IMPORT_NOT_READY"),
        );
    }
    let primary = &ready["primary"];
    if primary["revision"] != revision {
        return Err(ApiError::new(409, "主 Bot 已变化，请重新核对导入目标。")
            .with_code("MEMORY_IMPORT_PRIMARY_CHANGED"));
    }
    let cid = primary["conversationId"].as_str().unwrap().to_owned();
    let aid = primary["agentId"].as_str().unwrap().to_owned();
    let key = AgentRegistry::key(&wid, &cid);
    let _gate = state.agent_runs.queues.lock(&key).await;
    let admission = state.agent_runs.admission(wid).await?;
    let mut tx = store.begin().await?;
    if let Some((old, receipt)) = ledger::saved(&mut tx, &grant, &id).await? {
        if old != digest {
            return Err(ApiError::new(409, "同一次导入不能用于不同资料。")
                .with_code("MEMORY_IMPORT_REQUEST_CONFLICT"));
        }
        let view = ledger::view(&mut tx, receipt).await?;
        grant.authorize_owner(&state).await?;
        return Ok((StatusCode::OK, Json(view)));
    }
    let current = readiness_value(&mut tx, &store, &grant).await?;
    if current["available"] != true
        || current["primary"]["revision"] != revision
        || current["primary"]["agentId"] != aid
        || current["primary"]["conversationId"] != cid
    {
        return Err(ApiError::new(409, "导入目标或模型已变化，请重新核对。")
            .with_code("MEMORY_IMPORT_PRIMARY_CHANGED"));
    }
    let access = ExecutionAccess::MemoryImport {
        actor: grant.clone(),
        revision: revision.to_owned(),
        agent_id: aid.clone(),
        conversation_id: cid.clone(),
    };
    let mid = uuid::Uuid::new_v4().to_string();
    let at = iso(now());
    let reservation = if let Some(active) = state.agent_runs.get(&key).await {
        if active.cancelled.load(std::sync::atomic::Ordering::Acquire)
            || state.agent_runs.queues.len(&key).await >= 32
        {
            return Err(ApiError::new(
                409,
                "会话正在停止或等待队列已满，请稍后明确提交。",
            ));
        }
        None
    } else {
        Some(
            Reservation::reserve_kind(
                &state,
                &ExecutionAccess::User(grant.clone()),
                &cid,
                &aid,
                &mid,
                "memory_import",
            )
            .await?,
        )
    };
    let mut input = json!({"id":mid,"conversationId":cid,"userId":grant.user_id,"role":"user","kind":"text","content":"请整理我这次导入的个人资料，记住稳定偏好并告诉我结果。","createdAt":at,"delivery":{"state":"queued","mode":"followUp","agentId":aid,"clientId":id},"metadata":{"memoryImport":{"id":id,"requestId":id,"inputMessageId":mid},"author":{"id":grant.user_id,"name":grant.user_name,"kind":"user"}}});
    if let Some(reservation) = &reservation {
        input["delivery"]["runId"] = json!(reservation.active.run_id);
    }
    let receipt = json!({"requestId":id,"userId":grant.user_id,"workspaceId":wid,"primaryRevision":revision,"agentId":aid,"conversationId":cid,"messageId":mid,"createdAt":at,"status":"queued"});
    WorkspaceStore::put_in(&mut tx, Table::Messages, &input).await?;
    let mut chat = WorkspaceStore::get_in(&mut tx, Table::Conversations, &cid)
        .await?
        .unwrap();
    chat["updatedAt"] = json!(at);
    WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
    let mut bot = WorkspaceStore::get_in(&mut tx, Table::Agents, &aid)
        .await?
        .unwrap();
    bot["status"] = json!("working");
    WorkspaceStore::put_in(&mut tx, Table::Agents, &bot).await?;
    sqlx::query(
        "INSERT INTO memory_imports(actor_id,request_id,digest,data,message_id) VALUES(?,?,?,?,?)",
    )
    .bind(format!("user:{}", grant.user_id))
    .bind(&id)
    .bind(digest)
    .bind(receipt.to_string())
    .bind(&mid)
    .execute(&mut *tx)
    .await?;
    grant.authorize_owner(&state).await?;
    if state.is_closing() || state.agent_runs.is_closed() {
        return Err(ApiError::new(503, "服务正在关闭。"));
    }
    tx.commit().await?;
    store.emit("message", input.clone());
    store.emit("update", json!({}));
    if let Some(reservation) = reservation {
        input["executionPrompt"] = json!(content);
        reservation.launch(state.clone(), access, store, input);
    } else {
        // Admission survived the transaction; disconnecting HTTP must not discard its in-memory source.
        let queued_state = state.clone();
        tokio::spawn(async move {
            let _gate = _gate;
            let _admission = admission;
            queued_state
                .agent_runs
                .queues
                .push_kind(&key, access, input, "memory_import", Some(content))
                .await;
        });
    }
    grant.authorize_owner(&state).await?;
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}
