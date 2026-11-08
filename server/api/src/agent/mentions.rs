use crate::error::{ApiError, Result, only_fields};
use serde_json::{Value, json};

const MAX_RECIPIENTS: usize = 6;

pub(super) enum Intent<'a> {
    Explicit(Vec<&'a str>),
    Everyone,
}

pub(super) fn invalid() -> ApiError {
    ApiError::bad("请选择最多六位不同的群内 Bot，或选择所有 Bot。")
        .with_code("CHAT_MENTIONS_INVALID")
}

pub(super) fn unavailable() -> ApiError {
    ApiError::new(409, "一位或多位被提及的 Bot 已不可用，请重新选择。")
        .with_code("CHAT_MENTION_UNAVAILABLE")
}

pub(super) fn request(value: Option<&Value>) -> Result<Option<Intent<'_>>> {
    let Some(value) = value else { return Ok(None) };
    only_fields(value, &["agentIds", "everyone"]).map_err(|_| invalid())?;
    if value.get("everyone").is_some() {
        return if value["everyone"] == true && value.get("agentIds").is_none() {
            Ok(Some(Intent::Everyone))
        } else {
            Err(invalid())
        };
    }
    let ids = value["agentIds"]
        .as_array()
        .filter(|ids| (1..=MAX_RECIPIENTS).contains(&ids.len()))
        .ok_or_else(invalid)?;
    let mut distinct = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| super::messages::opaque(id))
            .ok_or_else(invalid)?;
        if !distinct.contains(&id) {
            distinct.push(id);
        }
    }
    Ok(Some(Intent::Explicit(distinct)))
}

pub(super) fn same_intent(requested: Option<&Intent<'_>>, message: &Value) -> bool {
    let current = message.get("mentions");
    match (requested, current) {
        (None, None) => true,
        (Some(Intent::Everyone), Some(value)) => value["everyone"] == true,
        (Some(Intent::Explicit(ids)), Some(value)) => {
            value.get("everyone").is_none() && value["agentIds"] == json!(ids)
        }
        _ => false,
    }
}

pub(super) fn resolve(intent: &Intent<'_>, conversation: &Value) -> Result<Value> {
    if conversation["isGroup"] != true {
        return Err(ApiError::bad("只有群聊支持提及多位 Bot 或所有 Bot。")
            .with_code("CHAT_MENTIONS_GROUP_REQUIRED"));
    }
    let members = conversation["agentIds"]
        .as_array()
        .ok_or_else(unavailable)?;
    match intent {
        Intent::Explicit(ids) => {
            if ids
                .iter()
                .any(|id| !members.iter().any(|member| member.as_str() == Some(id)))
            {
                return Err(unavailable());
            }
            Ok(json!({"agentIds":ids}))
        }
        Intent::Everyone => {
            let mut recipients = Vec::with_capacity(MAX_RECIPIENTS);
            for member in members {
                let id = member
                    .as_str()
                    .filter(|id| super::messages::opaque(id))
                    .ok_or_else(unavailable)?;
                if !recipients.contains(&id) {
                    if recipients.len() == MAX_RECIPIENTS {
                        return Err(ApiError::bad("此旧群聊超过六位 Bot，请单独选择收件人。")
                            .with_code("CHAT_MENTIONS_TOO_MANY"));
                    }
                    recipients.push(id);
                }
            }
            if recipients.is_empty() {
                return Err(unavailable());
            }
            Ok(json!({"agentIds":recipients,"everyone":true}))
        }
    }
}

pub(super) fn ids(value: &Value) -> impl Iterator<Item = &str> {
    value["agentIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

pub(super) fn attach(message: &mut Value, resolved: Value, first_run: Option<&str>) {
    let targets = ids(&resolved)
        .enumerate()
        .map(|(index, id)| {
            let mut target = json!({"agentId":id,"state":"queued"});
            if let Some(run) = first_run.filter(|_| index == 0) {
                target["runId"] = json!(run);
            }
            target
        })
        .collect::<Vec<_>>();
    message["mentions"] = resolved;
    message["delivery"]["mentionTargets"] = json!(targets);
}

pub(super) fn queued(message: &Value, agent: &str) -> bool {
    message["delivery"]["mentionTargets"]
        .as_array()
        .is_some_and(|targets| {
            targets
                .iter()
                .any(|target| target["agentId"] == agent && target["state"] == "queued")
        })
}

pub(crate) fn delivered_to(message: &Value, agent: &str, run: &str) -> bool {
    if message["delivery"]["state"] != "delivered" {
        return false;
    }
    if message.get("mentions").is_none() {
        return message["delivery"]["agentId"] == agent && message["delivery"]["runId"] == run;
    }
    message["delivery"]["mentionTargets"]
        .as_array()
        .is_some_and(|targets| {
            targets.iter().any(|target| {
                target["agentId"] == agent
                    && target["runId"] == run
                    && target["state"] == "delivered"
            })
        })
}

fn target_mut<'a>(message: &'a mut Value, agent: &str) -> Option<&'a mut Value> {
    message
        .get_mut("delivery")?
        .get_mut("mentionTargets")?
        .as_array_mut()?
        .iter_mut()
        .find(|target| target["agentId"] == agent)
}

pub(super) fn assign(message: &mut Value, agent: &str, run: &str) -> Result<()> {
    let target = target_mut(message, agent)
        .filter(|target| target["state"] == "queued")
        .ok_or_else(unavailable)?;
    target["runId"] = json!(run);
    if message["delivery"]["runId"].is_null() {
        message["delivery"]["runId"] = json!(run);
    }
    Ok(())
}

pub(super) fn begin(message: &mut Value, agent: &str, run: &str) -> bool {
    let Some(target) = target_mut(message, agent)
        .filter(|target| target["state"] == "queued" && target["runId"] == run)
    else {
        return false;
    };
    target["state"] = json!("delivered");
    message["delivery"]["state"] = json!("delivered");
    true
}

pub(super) fn abandon(message: &mut Value, agent: &str, status: &str, reason: &str) -> bool {
    let Some(target) = target_mut(message, agent).filter(|target| target["state"] == "queued")
    else {
        return false;
    };
    target["state"] = json!(status);
    target["reason"] = json!(reason);
    close_undelivered(message, status, reason);
    true
}

fn close_undelivered(message: &mut Value, status: &str, reason: &str) {
    if message["delivery"]["state"] == "queued"
        && !message["delivery"]["mentionTargets"]
            .as_array()
            .is_some_and(|targets| targets.iter().any(|target| target["state"] == "queued"))
    {
        message["delivery"]["state"] = json!(status);
        message["delivery"]["reason"] = json!(reason);
    }
}

pub(super) fn finish(message: &mut Value, agent: &str, run: &str, result: &Value) -> bool {
    let Some(target) = target_mut(message, agent).filter(|target| {
        target["runId"] == run
            && ["queued", "delivered"].contains(&target["state"].as_str().unwrap_or(""))
    }) else {
        return false;
    };
    let status = if result["status"] == "done" && target["state"] == "delivered" {
        "done"
    } else if result["metadata"]["executionStatus"] == "cancelled" {
        "cancelled"
    } else if target["state"] == "queued" || result["metadata"]["executionStatus"] == "interrupted"
    {
        "interrupted"
    } else {
        "error"
    };
    target["state"] = json!(status);
    close_undelivered(message, status, "任务未能开始，请核对执行结果后重试。");
    true
}

pub(crate) fn recover(message: &mut Value, reason: &str) -> bool {
    let Some(targets) = message
        .get_mut("delivery")
        .and_then(|delivery| delivery.get_mut("mentionTargets"))
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let mut changed = false;
    for target in targets {
        if target["state"] == "queued" || target["state"] == "delivered" {
            target["state"] = json!("interrupted");
            target["reason"] = json!(reason);
            changed = true;
        }
    }
    if changed {
        close_undelivered(message, "interrupted", reason);
    }
    changed
}
