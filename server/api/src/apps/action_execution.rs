use super::{
    Authority,
    actions::{self, Job},
    connections, interactive_rules,
    model::{PreparedCall, UNKNOWN},
    store, tool_access,
};
use crate::{
    db::State,
    error::{ApiError, Result},
};
use serde_json::json;
use std::sync::Arc;

pub(crate) fn start(state: &State, job: Arc<Job>, id: &str, approval: Authority) -> Result<()> {
    let prepared = job.prepared.clone();
    start_prepared(state, job, id, approval, prepared)
}

pub(crate) fn start_prepared(
    state: &State,
    job: Arc<Job>,
    id: &str,
    approval: Authority,
    prepared: PreparedCall,
) -> Result<()> {
    let lease = state.apps.enter()?;
    let state = state.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        let _lease = lease;
        let authorize: Authority = {
            let job = job.clone();
            let id = id.clone();
            Arc::new(move || {
                let (job, id, approval) = (job.clone(), id.clone(), approval.clone());
                Box::pin(async move {
                    if *job.stopped.borrow()
                        || actions::get(&job.recipient, &id).await?["status"] != "running"
                    {
                        return Err(ApiError::new(409, "应用操作已停止。"));
                    }
                    (job.authorize)().await?;
                    approval().await
                })
            })
        };
        let result = connections::execute(&state, &job.source, &prepared, authorize.clone()).await;
        let lock = state.apps.lock(&format!("action:{id}")).await;
        let _guard = lock.lock().await;
        let connection = state
            .apps
            .lock(&format!(
                "{}:{}",
                job.source.workspace_id, prepared.connection_id
            ))
            .await;
        let _connection_guard = connection.lock().await;
        let _ = finish(&job, &id, authorize, result).await;
        state.apps.jobs.lock().await.remove(&id);
    });
    Ok(())
}

async fn finish(
    job: &Job,
    id: &str,
    authorize: Authority,
    result: Result<serde_json::Value>,
) -> Result<()> {
    let mut saved = store::get_raw(&job.recipient, "app_actions", id).await?;
    if saved["action"]["status"] != "running" {
        return Ok(());
    }
    let authorized = result.is_ok()
        && authorize().await.is_ok()
        && tool_access::check_call(&job.source, &job.prepared)
            .await
            .is_ok();
    let mut tx = job.recipient.begin().await?;
    // Serialize revocation and result publication in the same workspace database.
    let active = match saved["interactiveRuleId"].as_str() {
        Some(id) => interactive_rules::still_active(&mut tx, id).await?,
        None => true,
    };
    match result {
        Ok(result) if authorized && active => {
            saved["action"]["status"] = json!("done");
            saved["action"]["result"] = result;
        }
        _ => {
            saved["action"]["status"] = json!("error");
            saved["action"]["error"] = json!(UNKNOWN);
        }
    }
    let card = actions::write_in(&mut tx, &saved).await?;
    tx.commit().await?;
    actions::emit(&job.recipient, card);
    Ok(())
}
