use super::{runtime::Live, store, validation};
use crate::{
    computer::{controller::Controller, controls::Lease},
    db::now,
    error::{ApiError, Result},
    workspace::WorkspaceAccess,
};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::OwnedSemaphorePermit;

pub async fn valid(live: &Live) -> Result<()> {
    live.check()?;
    live.actor.authorize_owner(&live.state).await?;
    let controller = live
        .controller
        .upgrade()
        .ok_or_else(|| ApiError::new(409, "电脑连接已关闭。"))?;
    controller.active()?;
    let expected = live
        .lease
        .as_ref()
        .ok_or_else(|| ApiError::new(409, "录制绑定已失效。"))?;
    expected.target.active()?;
    let mut health = crate::computer::transport::Request::get("/health");
    health.timeout = std::time::Duration::from_secs(2);
    expected
        .target
        .request(
            health,
            crate::computer::controller::user_authority(&live.state, &live.actor),
        )
        .await?;
    let current = controller
        .takeovers
        .lock()
        .await
        .get(&live.agent)
        .cloned()
        .ok_or_else(|| ApiError::new(409, "人工接管已结束。"))?;
    if current.id != expected.id
        || current.expires_at <= now()
        || !Arc::ptr_eq(&current.target, &expected.target)
    {
        return Err(ApiError::new(409, "人工画面或接管已变化。"));
    }
    if live
        .state
        .agent_runs
        .agent_busy(&live.actor.workspace_id, &live.agent, None)
        .await
        || controller.tasks.busy(Some(&live.agent))
    {
        return Err(ApiError::new(409, "Bot 已开始工作，录制已中断。"));
    }
    let mut tx = live.store.pool.begin().await?;
    let saved = store::get(&mut tx, &live.id, &live.actor).await?;
    let bot = store::subject(&mut tx, &live.agent, &live.conversation).await?;
    if bot["configRevision"] != saved["agentRevision"] {
        return Err(ApiError::new(409, "Bot 资料已变化。"));
    }
    live.check()
}
pub async fn monitor(live: Arc<Live>) {
    let mut cancel = live.cancelled.subscribe();
    let mut security = live.state.subscribe_security();
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(600));
    tokio::pin!(deadline);
    loop {
        if live.ended.load(Ordering::Acquire) {
            break;
        }
        if *cancel.borrow() {
            break;
        }
        tokio::select! {
            _=interval.tick()=>{if valid(&live).await.is_err(){live.interrupt("binding_or_access_changed");}},
            _=security.recv()=>{if valid(&live).await.is_err(){live.interrupt("binding_or_access_changed");}},
            _=cancel.changed()=>{},
            _=&mut deadline=>{live.interrupt("recording_deadline");},
        }
    }
    let reason = *live.reason.lock().unwrap();
    if let Some(reason) = reason {
        let _ = interrupt_saved(&live, reason).await;
    }
    live.state.teaching.remove(&live);
}
pub async fn interrupt_saved(live: &Live, reason: &str) -> Result<()> {
    let _permit = live
        .serial
        .acquire()
        .await
        .map_err(|_| ApiError::new(409, "录制已关闭。"))?;
    let mut tx = live.store.begin().await?;
    let mut saved = store::get(&mut tx, &live.id, &live.actor).await?;
    if saved["status"] == "recording" || saved["status"] == "review" {
        saved["status"] = json!("interrupted");
        saved["interrupted"] = json!(true);
        saved["reason"] = json!(reason);
        saved["stoppedAt"] = json!(crate::db::iso(now()));
        store::stamp(&mut saved);
        store::save(&mut tx, &saved).await?;
    }
    tx.commit().await?;
    live.store.emit("update", json!({}));
    Ok(())
}
pub struct InputRecord {
    live: Arc<Live>,
    step: Value,
    _permit: OwnedSemaphorePermit,
    complete: bool,
}
impl Drop for InputRecord {
    fn drop(&mut self) {
        if !self.complete {
            self.live.interrupt("input_not_confirmed");
        }
    }
}
pub async fn before_input(
    controller: &Arc<Controller>,
    actor: &WorkspaceAccess,
    lease: &Lease,
    body: &Value,
) -> Result<Option<InputRecord>> {
    let Some(agent) = lease.agent_id.as_deref() else {
        return Ok(None);
    };
    let Some(live) = controller.teaching.for_agent(&actor.workspace_id, agent) else {
        return Ok(None);
    };
    if live.actor.user_id != actor.user_id
        || live.actor.session_id != actor.session_id
        || live.lease.as_ref().is_none_or(|l| l.id != lease.id)
    {
        live.interrupt("binding_or_access_changed");
        return Err(ApiError::new(409, "教学录制不属于当前接管。"));
    }
    let permit = live
        .serial
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::new(409, "录制已关闭。"))?;
    if let Err(error) = valid(&live).await {
        live.interrupt("binding_or_access_changed");
        return Err(error);
    }
    Ok(Some(InputRecord {
        live,
        step: validation::step(body),
        _permit: permit,
        complete: false,
    }))
}
pub async fn input_succeeded(record: Option<InputRecord>) -> Result<()> {
    let Some(mut record) = record else {
        return Ok(());
    };
    valid(&record.live).await?;
    let mut tx = record.live.store.begin().await?;
    let mut saved = store::get(&mut tx, &record.live.id, &record.live.actor).await?;
    let subject = store::subject(&mut tx, &record.live.agent, &record.live.conversation).await?;
    if subject["configRevision"] != saved["agentRevision"] {
        return Err(ApiError::new(409, "Bot 资料已变化，最后一步未记录。"));
    }
    if saved["status"] != "recording" {
        return Err(ApiError::new(409, "录制已经停止。"));
    }
    let steps = saved["steps"]
        .as_array_mut()
        .ok_or_else(|| ApiError::bad("教学记录无效。"))?;
    if steps.len() >= 60 {
        record.live.interrupt("step_limit");
        return Err(ApiError::new(413, "已达到教学步骤上限，请先停止录制。"));
    }
    steps.push(record.step.clone());
    store::stamp(&mut saved);
    store::save(&mut tx, &saved).await?;
    record
        .live
        .actor
        .authorize_owner(&record.live.state)
        .await?;
    record.live.check()?;
    tx.commit().await?;
    record.complete = true;
    if saved["steps"]
        .as_array()
        .is_some_and(|steps| steps.len() >= 60)
    {
        record.live.interrupt("step_limit");
    }
    record.live.store.emit("update", json!({}));
    Ok(())
}
