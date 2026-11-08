use super::{recording, runtime::Live, store, validation};
use crate::{
    computer::controller,
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields},
    workspace::access,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Semaphore, watch};

pub async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let ws = actor.store(&state).await?;
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM teaching_sessions WHERE user_id=? ORDER BY rowid DESC LIMIT 30",
    )
    .bind(&actor.user_id)
    .fetch_all(&ws.pool)
    .await?;
    let values = rows
        .into_iter()
        .map(|raw| store::decode(&raw).map(|v| store::public(&v)))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    actor.authorize_owner(&state).await?;
    Ok(Json(json!(values)))
}
pub async fn get(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let ws = actor.store(&state).await?;
    let mut tx = ws.pool.begin().await?;
    let value = store::get(&mut tx, &id, &actor).await?;
    actor.authorize_owner(&state).await?;
    Ok(Json(store::public(&value)))
}
pub async fn start(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let (send, receive) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = send.send(start_owned(state, actor, body).await);
    });
    receive
        .await
        .map_err(|_| ApiError::new(502, "教学开始结果尚未确认，请重新查看记录。"))?
}
async fn start_owned(
    state: State,
    actor: crate::workspace::WorkspaceAccess,
    body: Value,
) -> Result<Json<Value>> {
    let wid = actor.workspace_id.clone();
    only_fields(
        &body,
        &["requestId", "agentId", "conversationId", "leaseId"],
    )?;
    let id = validation::uuid(&body["requestId"])?.to_owned();
    let agent = validation::string(&body["agentId"], 128, false)?;
    let conversation = validation::string(&body["conversationId"], 128, false)?;
    let ws = actor.store(&state).await?;
    {
        let mut tx = ws.pool.begin().await?;
        if let Ok(prior) = store::get(&mut tx, &id, &actor).await {
            if prior["agentId"] != agent
                || prior["conversationId"] != conversation
                || prior["leaseId"] != body["leaseId"]
            {
                return Err(ApiError::new(409, "此请求已用于另一段教学。"));
            }
            actor.authorize_owner(&state).await?;
            return Ok(Json(store::public(&prior)));
        }
    }
    let computer = state.computer.get(&state, ws.clone()).await?;
    let lease = computer
        .takeovers
        .lock()
        .await
        .get(&agent)
        .cloned()
        .ok_or_else(|| ApiError::new(409, "请先接管此 Bot 的电脑画面。"))?;
    if body["leaseId"] != lease.id
        || lease.user_id != actor.user_id
        || lease.session_id != actor.session_id
        || lease.expires_at <= now()
    {
        return Err(ApiError::new(409, "教学必须使用本人当前的人工接管。"));
    }
    let authority = controller::user_authority(&state, &actor);
    lease
        .target
        .request(
            crate::computer::transport::Request::get("/health"),
            authority,
        )
        .await?;
    let mut screen =
        json!({"instanceId":lease.target.saved.instance_id,"surface":lease.value["surface"]});
    if let Some(binding) = &lease.target.binding {
        screen["screenId"] = json!(binding.screen_id);
        screen["revision"] = json!(binding.screen_revision);
        screen["generation"] = json!(binding.session.generation);
    }
    let (cancelled, _) = watch::channel(false);
    let live = Arc::new(Live {
        id: id.clone(),
        state: state.clone(),
        actor: actor.clone(),
        store: ws.clone(),
        agent: agent.clone(),
        conversation: conversation.clone(),
        controller: Arc::downgrade(&computer),
        lease: Some(lease.clone()),
        serial: Arc::new(Semaphore::new(1)),
        cancelled,
        reason: Mutex::new(None),
        ended: AtomicBool::new(false),
        recording: true,
    });
    state.teaching.insert(live.clone())?;
    let accepted=async{
        if state.agent_runs.agent_busy(&wid,&agent,None).await||computer.tasks.busy(Some(&agent)){return Err(ApiError::new(409,"Bot 正在工作，请先结束任务再教学。"));}
        let mut tx=ws.begin().await?;
        if sqlx::query_scalar::<_,i64>("SELECT count(*) FROM teaching_closures WHERE user_id=? AND id=?").bind(&actor.user_id).bind(&id).fetch_one(&mut *tx).await?>0 {return Err(ApiError::new(410,"该录制请求已关闭。").with_code("TEACHING_CLOSED"));}
        let bot=store::subject(&mut tx,&agent,&conversation).await?;
        let timestamp=iso(now());
        let value=json!({"id":id,"revision":uuid::Uuid::new_v4().to_string(),"userId":actor.user_id,"sessionId":actor.session_id,"agentId":agent,"agentRevision":bot["configRevision"],"conversationId":conversation,"leaseId":lease.id,"screen":screen,"status":"recording","createdAt":timestamp,"updatedAt":timestamp,"goal":"","steps":[],"interrupted":false});
        if sqlx::query_scalar::<_,i64>("SELECT count(*) FROM teaching_sessions WHERE id=?").bind(&id).fetch_one(&mut *tx).await?>0{return Err(ApiError::new(409,"此教学请求已存在，请重新核对。"));}
        store::save(&mut tx,&value).await?;actor.authorize_owner(&state).await?;live.check()?;tx.commit().await?;Ok::<_,ApiError>(value)
    }.await;
    let value = match accepted {
        Ok(value) => value,
        Err(error) => {
            state.teaching.remove(&live);
            return Err(error);
        }
    };
    tokio::spawn(recording::monitor(live));
    ws.emit("update", json!({}));
    actor.authorize_owner(&state).await?;
    Ok(Json(store::public(&value)))
}
pub async fn stop(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &[])?;
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let ws = actor.store(&state).await?;
    let live = state.teaching.get(&wid, &id);
    let _permit = if let Some(live) = &live {
        Some(
            live.serial
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| ApiError::new(409, "教学已停止。"))?,
        )
    } else {
        None
    };
    let validity = if let Some(live) = &live {
        recording::valid(live).await
    } else {
        Err(ApiError::new(409, "录制已经中断。"))
    };
    let mut tx = ws.begin().await?;
    let mut value = store::get(&mut tx, &id, &actor).await?;
    if value["status"] == "recording" {
        if value["sessionId"] != actor.session_id {
            return Err(ApiError::new(409, "只能从原登录会话停止录制。"));
        }
        let subject = store::subject(
            &mut tx,
            value["agentId"].as_str().unwrap_or(""),
            value["conversationId"].as_str().unwrap_or(""),
        )
        .await;
        let current = validity.is_ok()
            && subject.is_ok_and(|bot| bot["configRevision"] == value["agentRevision"])
            && live.as_ref().is_some_and(|live| live.check().is_ok());
        value["status"] = json!(if current { "review" } else { "interrupted" });
        if !current {
            value["interrupted"] = json!(true);
            value["reason"] = json!("binding_or_access_changed");
        }
        value["stoppedAt"] = json!(iso(now()));
        store::stamp(&mut value);
        store::save(&mut tx, &value).await?;
    }
    actor.authorize_owner(&state).await?;
    tx.commit().await?;
    if let Some(live) = live {
        if live.recording {
            live.ended.store(true, Ordering::Release);
            live.cancelled.send_replace(true);
            state.teaching.remove(&live);
        }
    }
    ws.emit("update", json!({}));
    Ok(Json(store::public(&value)))
}
pub async fn cancel(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &[])?;
    validation::uuid(&json!(id))?;
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let ws = actor.store(&state).await?;
    let mut tx = ws.begin().await?;
    let raw: Option<String> =
        sqlx::query_scalar("SELECT data FROM teaching_sessions WHERE id=? AND user_id=?")
            .bind(&id)
            .bind(&actor.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let value = if let Some(raw) = raw {
        let mut value = store::decode(&raw)?;
        if value["status"] != "proposed" {
            if let Some(live) = state.teaching.get(&wid, &id) {
                live.interrupt("user_cancelled");
            }
            if value["status"] == "recording" {
                value["status"] = json!("interrupted");
                value["interrupted"] = json!(true);
                value["stoppedAt"] = json!(iso(now()));
            }
            if value["status"] == "generating" {
                value["status"] = json!("error");
            }
            value["reason"] = json!("user_cancelled");
            store::stamp(&mut value);
            store::save(&mut tx, &value).await?;
        }
        store::public(&value)
    } else {
        sqlx::query("INSERT OR IGNORE INTO teaching_closures VALUES(?,?)")
            .bind(&actor.user_id)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        json!({"id":id,"status":"closed"})
    };
    actor.authorize_owner(&state).await?;
    tx.commit().await?;
    ws.emit("update", json!({}));
    Ok(Json(value))
}
pub async fn review(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let ws = actor.store(&state).await?;
    let mut tx = ws.begin().await?;
    let saved = store::get(&mut tx, &id, &actor).await?;
    store::expected(&saved, &body["expectedRevision"])?;
    if !["review", "interrupted", "error"].contains(&saved["status"].as_str().unwrap_or("")) {
        return Err(ApiError::new(409, "请先停止录制，生成中的草稿暂不能编辑。"));
    }
    store::subject(
        &mut tx,
        saved["agentId"].as_str().unwrap(),
        saved["conversationId"].as_str().unwrap(),
    )
    .await?;
    let mut value = validation::review(&saved, &body)?;
    store::stamp(&mut value);
    store::save(&mut tx, &value).await?;
    actor.authorize_owner(&state).await?;
    tx.commit().await?;
    ws.emit("update", json!({}));
    Ok(Json(store::public(&value)))
}
