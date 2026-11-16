use super::{
    accessibility,
    approvals::Job,
    controller::Controller,
    frames, model, skill_scripts, transfers,
    transport::{Authority, Request},
    validation,
};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::sync::Arc;

fn authority(job: &Arc<Job>, decision: Option<Authority>) -> Authority {
    let job = job.clone();
    Arc::new(move || {
        let job = job.clone();
        let decision = decision.clone();
        Box::pin(async move {
            if *job.stopped.borrow() {
                return Err(ApiError::new(
                    409,
                    "电脑操作已取消，已经发生的效果不会回滚。",
                ));
            }
            (job.authorize)().await?;
            if let Some(check) = decision {
                check().await?;
            }
            Ok(())
        })
    })
}
pub(super) async fn execute(
    controller: &Arc<Controller>,
    job: &Arc<Job>,
    action: &Value,
    decision: Option<Authority>,
) -> Result<Value> {
    let authorize = authority(job, decision);
    authorize().await?;
    let kind = action["type"].as_str().unwrap_or("");
    if kind == skill_scripts::KIND {
        skill_scripts::require_target(controller, &job.target).await?;
        let input = skill_scripts::worker_payload(
            &controller.store,
            job.context.agent_id.as_deref().ok_or_else(model::invalid)?,
            job.context
                .conversation_id
                .as_deref()
                .ok_or_else(model::invalid)?,
            &action["payload"],
        )
        .await?;
        let mut request = Request::post("/execute-skill-script", &input);
        request.shell_id = Some(action["id"].as_str().ok_or_else(model::invalid)?.to_owned());
        let result = job
            .target
            .request(request, authorize.clone())
            .await?
            .json()?;
        authorize().await?;
        validation::shell_result(&result)?;
        return Ok(json!({"result":result}));
    }
    if matches!(kind, "upload_file" | "download_file") {
        return Ok(
            json!({"result":transfers::execute(&controller.store,&job.target,&action["payload"],job.context.conversation_id.as_deref(),job.context.agent_id.as_deref(),authorize).await?}),
        );
    }
    let with_frame = validation::frame_action(kind)
        && job.context.conversation_id.is_some()
        && job.context.agent_id.is_some()
        && job
            .target
            .saved
            .capabilities
            .iter()
            .any(|c| c == "action-frames");
    let open_payload = (kind == accessibility::OPEN)
        .then(|| accessibility::launch_payload(action, job.app_identity.as_deref()))
        .transpose()?;
    let mut request = Request::post(
        if with_frame {
            "/execute-with-frame"
        } else {
            "/execute"
        },
        open_payload.as_ref().unwrap_or(&action["payload"]),
    );
    if matches!(kind, "remote_shell" | "local_shell") {
        request.shell_id = action["id"].as_str().map(str::to_owned);
    }
    let value = job
        .target
        .request(request, authorize.clone())
        .await?
        .json()?;
    authorize().await?;
    if accessibility::mutation(kind) {
        if value["ok"] != true {
            return Err(model::invalid());
        }
        return Ok(json!({"result":{"ok":true}}));
    }
    if matches!(kind, "remote_shell" | "local_shell") {
        super::validation::shell_result(&value)?;
    }
    if !with_frame {
        return Ok(json!({"result":value}));
    }
    if value.get("result").is_none() {
        return Err(model::invalid());
    }
    let mut result = json!({"result":value["result"]});
    if let Some(frame) = value.get("frame") {
        match frames::save(
            &controller.store,
            &job.target,
            frame,
            job.context.conversation_id.as_deref().unwrap(),
            job.context.agent_id.as_deref().unwrap(),
            authorize.clone(),
        )
        .await
        {
            Ok(frame) => result["frame"] = frame,
            Err(_) => result["frameUnavailable"] = json!("操作已完成，但当时画面未能保存。"),
        }
    } else {
        result["frameUnavailable"] = json!("操作已完成，但当时画面未能保存。");
    }
    authorize().await?;
    Ok(result)
}
