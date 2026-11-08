use crate::{
    db::{State, iso, now},
    error::Result,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};

/// Workspace administration uses the same scoped snapshot as the client.
pub async fn get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = super::access::require(&state, &headers, &wid, true, true).await?;
    let Json(data) =
        super::snapshot::bootstrap(Extract(state.clone()), Path(wid.clone()), headers.clone())
            .await?;
    let Json(models) = super::model::get(Extract(state.clone()), Path(wid), headers).await?;
    let array = |name: &str| data[name].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let agents = array("agents");
    let chats = array("conversations");
    let messages = array("messages");
    let files = array("files");
    let routines = array("routines");
    let skills = array("skills");
    let mut records = messages
        .iter()
        .filter(|message| message["role"] != "user" && message["status"].as_str().is_some())
        .collect::<Vec<_>>();
    records.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    let record = |message: &Value| {
        let agent = agents
            .iter()
            .find(|agent| agent["id"] == message["agentId"]);
        let conversation = chats
            .iter()
            .find(|chat| chat["id"] == message["conversationId"]);
        json!({"id":message["id"],"conversationId":message["conversationId"],"conversationTitle":conversation.map(|chat|chat["title"].clone()).unwrap_or(json!("")),"agentId":message["agentId"],"agentName":agent.map(|agent|agent["name"].clone()).unwrap_or(json!("Bot")),"kind":message["kind"].as_str().unwrap_or("text"),"status":message["status"],"createdAt":message["createdAt"],"summary":message["content"].as_str().unwrap_or("").chars().take(240).collect::<String>(),"tool":message["tool"]})
    };
    let running=data["runningConversationIds"].as_array().cloned().unwrap_or_default().iter().filter_map(|id|chats.iter().find(|chat|chat["id"]==*id)).map(|chat|{
        let first=messages.iter().find(|message|message["conversationId"]==chat["id"]&&message["status"]=="running");let mut value=json!({"id":chat["id"],"title":chat["title"],"isGroup":chat["isGroup"],"agentIds":chat["agentIds"]});if let Some(first)=first{value["startedAt"]=first["createdAt"].clone();}value
    }).collect::<Vec<_>>();
    let scheduler_enabled = state.scheduler.is_running().await;
    let response = json!({
        "generatedAt":iso(now()),
        "resources":{"bots":agents.len(),"conversations":chats.len(),"demoConversations":0,"files":files.len(),"fileBytes":files.iter().filter_map(|file|file["size"].as_u64()).sum::<u64>(),"memories":array("memories").len(),"routines":routines.len(),"enabledRoutines":routines.iter().filter(|r|r["enabled"]==true).count(),"pendingSkills":skills.iter().filter(|s|s["status"]=="proposed").count(),"activeSkills":skills.iter().filter(|s|s["status"]=="active").count()},
        "execution":{"runningConversations":running,"queuedMessages":messages.iter().filter(|message|message["delivery"]["state"]=="queued").count(),"recentRecords":records.iter().take(20).map(|message|record(message)).collect::<Vec<_>>(),"recentErrors":records.iter().filter(|message|message["status"]=="error").take(20).map(|message|record(message)).collect::<Vec<_>>(),"recordLimit":20,"recordScope":"stored-execution-messages"},
        "settings":data["settings"],"models":models,"computer":data["computer"],
        "deployment":{"mode":if state.config.public_origin.is_some(){"remote"}else{"local"},"bindHost":state.config.bind.ip().to_string(),"publicOrigin":state.config.public_origin,"storage":"sqlite","runtime":"pi","access":"workspace-members","authentication":"accounts","schedulerEnabled":scheduler_enabled,"computerStatusSource":"last-known"}
    });
    grant.authorize(&state).await?;
    Ok(Json(response))
}
