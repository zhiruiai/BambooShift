use super::{
    controller::Controller,
    model::{self, DesktopSession},
    screen_bindings::{self, Operation},
    transport::{Authority, Request},
};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub async fn begin(
    controller: &Arc<Controller>,
    agent: &str,
    kind: &str,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    let _guard = controller.management.lock().await;
    controller.active()?;
    authorize().await?;
    if !["release", "reset"].contains(&kind) || body["confirm"] != true {
        return Err(ApiError::bad("请明确确认此画面维护操作。"));
    }
    let revision = body["assignmentRevision"]
        .as_str()
        .filter(|s| model::uuid(s))
        .ok_or_else(|| ApiError::bad("画面版本无效。"))?;
    let mut journal = controller.bindings.lock().await.clone();
    if journal.operations.iter().any(|o| {
        o.agent_id == agent
            && o.kind == kind
            && o.binding.assignment_revision == revision
            && o.status == "complete"
    }) {
        return screen_bindings::status(controller, agent, authorize).await;
    }
    if journal
        .operations
        .iter()
        .any(|o| o.agent_id == agent && o.status != "complete")
    {
        return Err(ApiError::new(
            409,
            "已有维护操作尚未完成，请继续处理原记录。",
        ));
    }
    let mut binding = journal
        .bindings
        .iter()
        .find(|b| b.agent_id == agent && b.assignment_revision == revision)
        .cloned()
        .ok_or_else(|| ApiError::new(409, "画面绑定已变化，请刷新后重新确认。"))?;
    if controller.busy(Some(agent)).await {
        return Err(ApiError::new(
            409,
            "请先结束此 Bot 的任务、审批和人工接管。",
        ));
    }
    let target = controller.target(authorize.clone()).await?;
    if !target
        .saved
        .capabilities
        .iter()
        .any(|c| c == model::LIFECYCLE)
    {
        return Err(ApiError::new(409, "当前电脑不支持安全释放或重置画面。"));
    }
    let inventory = screen_bindings::inventory(controller, authorize.clone()).await?;
    let screen = inventory["screens"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == binding.screen_id)
        .ok_or_else(|| ApiError::new(409, "远程画面已不可用。"))?;
    if DesktopSession::parse(&screen["session"])? != binding.session
        || binding
            .screen_revision
            .as_ref()
            .is_some_and(|r| screen["revision"] != *r)
    {
        return Err(model::invalid());
    }
    binding.screen_revision = Some(
        screen["revision"]
            .as_str()
            .filter(|r| model::uuid(r))
            .ok_or_else(model::invalid)?
            .into(),
    );
    let current = screen_bindings::status(controller, agent, authorize.clone()).await?;
    if current["botScreen"]["lifecycle"][if kind == "release" {
        "releaseAllowed"
    } else {
        "resetAllowed"
    }] != true
    {
        return Err(ApiError::new(409, "当前画面暂不能执行此维护操作。"));
    }
    if journal.operations.len() >= 2000 {
        return Err(ApiError::new(409, "画面维护记录已满，请联系维护人员。"));
    }
    let reservation = controller.tasks.maintain(agent)?;
    authorize().await?;
    let operation = Operation {
        operation_id: uuid::Uuid::new_v4().to_string(),
        agent_id: agent.into(),
        kind: kind.into(),
        binding,
        next_assignment_revision: uuid::Uuid::new_v4().to_string(),
        status: "pending".into(),
        receipt: None,
    };
    journal.operations.push(operation.clone());
    screen_bindings::save(&controller.store, &journal)?;
    *controller.bindings.lock().await = journal;
    controller.changed();
    let result = process(controller, operation, authorize.clone()).await;
    drop(reservation);
    controller.changed();
    result?;
    screen_bindings::status(controller, agent, authorize).await
}
pub async fn resume(
    controller: &Arc<Controller>,
    agent: &str,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    let _guard = controller.management.lock().await;
    controller.active()?;
    authorize().await?;
    if body["confirm"] != true {
        return Err(ApiError::bad("请明确确认继续处理原维护记录。"));
    }
    let journal = controller.bindings.lock().await.clone();
    let operation = journal
        .operations
        .iter()
        .find(|o| {
            o.agent_id == agent
                && body["operationId"] == o.operation_id
                && body["assignmentRevision"] == o.binding.assignment_revision
        })
        .cloned()
        .ok_or_else(|| ApiError::new(409, "原维护记录不存在或版本不匹配。"))?;
    if operation.status == "complete" {
        return screen_bindings::status(controller, agent, authorize).await;
    }
    if controller.busy(Some(agent)).await {
        return Err(ApiError::new(409, "此画面仍有操作未结束，请稍后继续。"));
    }
    let reservation = controller.tasks.maintain(agent)?;
    let result = process(controller, operation, authorize.clone()).await;
    drop(reservation);
    controller.changed();
    result?;
    screen_bindings::status(controller, agent, authorize).await
}
async fn process(
    controller: &Arc<Controller>,
    operation: Operation,
    authorize: Authority,
) -> Result<Value> {
    if let Some(target) = controller
        .screen_targets
        .lock()
        .await
        .remove(&operation.agent_id)
    {
        target.close().await;
    }
    let result = dispatch(controller, &operation, authorize.clone()).await;
    let mut journal = controller.bindings.lock().await.clone();
    let index = journal
        .operations
        .iter()
        .position(|o| o.operation_id == operation.operation_id)
        .ok_or_else(model::invalid)?;
    match result {
        Ok(receipt) => {
            if receipt["status"] == "complete" {
                let index_binding = journal
                    .bindings
                    .iter()
                    .position(|b| {
                        b.agent_id == operation.agent_id
                            && b.assignment_revision == operation.binding.assignment_revision
                    })
                    .ok_or_else(model::invalid)?;
                if operation.kind == "release" {
                    journal.bindings.remove(index_binding);
                } else {
                    let binding = &mut journal.bindings[index_binding];
                    binding.assignment_revision = operation.next_assignment_revision.clone();
                    binding.session = DesktopSession::parse(&receipt["next"]["session"])?;
                    binding.screen_revision =
                        receipt["next"]["revision"].as_str().map(str::to_owned);
                }
                journal.operations[index].status = "complete".into();
            } else {
                journal.operations[index].status = "blocked".into();
            }
            journal.operations[index].receipt = Some(receipt);
        }
        Err(_) => journal.operations[index].status = "blocked".into(),
    }
    screen_bindings::save(&controller.store, &journal)?;
    let complete = journal.operations[index].status == "complete";
    *controller.bindings.lock().await = journal;
    if complete {
        super::action_store::clear_recovery(&controller.store, &operation.agent_id).await?;
        controller.tasks.clear_blocked(&operation.agent_id);
        super::job_retirement::recovered(controller, &operation.agent_id).await;
    }
    controller.changed();
    screen_bindings::status(controller, &operation.agent_id, authorize).await
}
async fn dispatch(
    controller: &Arc<Controller>,
    operation: &Operation,
    authorize: Authority,
) -> Result<Value> {
    let target = controller.target(authorize.clone()).await?;
    let revision = operation
        .binding
        .screen_revision
        .as_deref()
        .ok_or_else(model::invalid)?;
    let body = json!({"operationId":operation.operation_id,"kind":operation.kind,"expectedRevision":revision,"expectedSession":operation.binding.session});
    let mut request = Request::post(
        format!("/screens/{}/lifecycle", operation.binding.screen_id),
        &body,
    );
    request.timeout = Duration::from_secs(105);
    request.max_bytes = 16384;
    request.allow_lifecycle_error = true;
    request.maintenance_screen = Some((operation.binding.screen_id.clone(), revision.into()));
    let receipt = target.request(request, authorize).await?.json()?;
    validate_receipt(operation, &receipt)?;
    Ok(receipt)
}
pub fn validate_receipt(operation: &Operation, receipt: &Value) -> Result<()> {
    let previous = DesktopSession::parse(&receipt["previous"]["session"])?;
    let next = DesktopSession::parse(&receipt["next"]["session"])?;
    if receipt["version"] != 1
        || receipt["operationId"] != operation.operation_id
        || receipt["screenId"] != operation.binding.screen_id
        || receipt["kind"] != operation.kind
        || !matches!(
            receipt["status"].as_str(),
            Some("pending" | "complete" | "blocked")
        )
        || !matches!(
            receipt["phase"].as_str(),
            Some("reserved" | "browser_closed" | "desktop_ready" | "complete")
        )
        || (receipt["status"] == "complete") != (receipt["phase"] == "complete")
        || receipt["previous"]["revision"].as_str() != operation.binding.screen_revision.as_deref()
        || previous != operation.binding.session
        || next.generation == previous.generation
        || (operation.kind == "reset") != (previous.id == next.id)
        || !receipt["next"]["revision"]
            .as_str()
            .is_some_and(model::uuid)
        || receipt["next"]["revision"] == receipt["previous"]["revision"]
    {
        return Err(model::invalid());
    }
    Ok(())
}
