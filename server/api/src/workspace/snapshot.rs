use super::{Table, WorkspaceStore, access};
use crate::{db::State, error::Result};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
};
use serde_json::{Value, json};
use tokio_stream::wrappers::ReceiverStream;

pub async fn bootstrap(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, false).await?;
    let store = grant.store(&state).await?;
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.pool.begin().await?;
    let mut data =
        json!({"sync":store.sync(),"runningConversationIds":[],"runningRequests":[],"apps":[]});
    for table in [
        Table::Agents,
        Table::Conversations,
        Table::Messages,
        Table::Memories,
        Table::Routines,
        Table::Skills,
        Table::Files,
    ] {
        let mut values = WorkspaceStore::list_in(&mut tx, table).await?;
        if matches!(table, Table::Conversations) {
            super::unread::project(&mut tx, &grant.user_id, &mut values).await?;
        }
        data[table.name()] = json!(values);
    }
    data["sidebarRoster"] = super::roster::read(&mut tx, &grant.user_id).await?;
    data["primaryBot"] = super::primary::read(&mut tx, &grant.kind).await?;
    data["workspaceTimeZone"] = super::time_zone::read(&mut tx).await?;
    data["settings"] = super::model::settings(&store, &mut tx).await?;
    let default_configured = data["settings"]["configured"] == true;
    let mut model_readiness = std::collections::HashMap::new();
    for agent in data["agents"].as_array_mut().unwrap() {
        let selected = agent["modelProfileId"]
            .as_str()
            .filter(|_| agent.get("sharedBot").is_none());
        let configured = if let Some(profile) = selected {
            if let Some(configured) = model_readiness.get(profile) {
                *configured
            } else {
                let configured = super::model::bot_configured_in(
                    &store,
                    &mut tx,
                    agent["id"].as_str().unwrap_or(""),
                )
                .await
                .unwrap_or(false);
                model_readiness.insert(profile.to_owned(), configured);
                configured
            }
        } else {
            default_configured
        };
        agent["modelConfigured"] = json!(configured);
    }
    let any_local_model = data["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|agent| agent.get("sharedBot").is_none() && agent["modelConfigured"] == true);
    data["voiceMemo"] = json!({"available": grant.kind == "personal"
        && grant.is_owner && any_local_model
        && crate::speech::memo_synthesis::available(&state.config.data_dir)});
    let primary_configured = data["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == data["primaryBot"]["agentId"])
        .is_some_and(|agent| agent["modelConfigured"] == true);
    data["primaryCheckIn"] = crate::scheduling::primary_status(
        &mut tx,
        &grant.kind,
        primary_configured,
        crate::db::now(),
    )
    .await?;
    tx.commit().await?;
    data["computer"] = state
        .computer
        .get(&state, store.clone())
        .await?
        .state()
        .await;
    crate::shared_bots::project_snapshot(&state, &grant, &mut data).await?;
    for agent in data["agents"].as_array_mut().unwrap() {
        if agent.get("sharedBot").is_some() {
            agent["modelConfigured"] = json!(default_configured);
        }
    }
    data["apps"] = json!(crate::apps::connections::list(&store).await?);
    let running = state.agent_runs.requests(&wid).await;
    data["runningConversationIds"] = json!(
        running
            .iter()
            .map(|run| run["conversationId"].clone())
            .collect::<Vec<_>>()
    );
    data["runningRequests"] = json!(running);
    grant.authorize(&state).await?;
    Ok(Json(data))
}
pub async fn events(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse> {
    let grant = access::require(&state, &headers, &wid, false, false).await?;
    let store = grant.store(&state).await?;
    let mut source = store.subscribe();
    let mut security = state.subscribe_security();
    let (send, receive) =
        tokio::sync::mpsc::channel::<std::result::Result<Event, std::convert::Infallible>>(32);
    let initial = store.sync();
    tokio::spawn(async move {
        if grant.authorize(&state).await.is_err() {
            return;
        }
        let sync = Event::default().event("sync").data(initial.to_string());
        if send.send(Ok(sync)).await.is_err() {
            return;
        }
        if send
            .send(Ok(Event::default().event("connected").data("{}")))
            .await
            .is_err()
        {
            return;
        }
        let mut check = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tokio::select! {
                _=send.closed()=>break,
                _=security.recv()=>{if store.is_closed()||grant.authorize(&state).await.is_err(){break;}},
                _=check.tick()=>{if store.is_closed()||grant.authorize(&state).await.is_err(){break;}},
                event=source.recv()=>{
                    if store.is_closed()||grant.authorize(&state).await.is_err(){break;}
                    let event=match event {Ok(value)=>Event::default().event(value.event).id(format!("{}:{}",initial["epoch"].as_str().unwrap_or(""),value.revision)).data(value.data.to_string()),Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>Event::default().event("update").data("{}"),Err(_)=>break};
                    if send.send(Ok(event)).await.is_err(){break;}
                }
            }
        }
    });
    Ok(Sse::new(ReceiverStream::new(receive)).keep_alive(KeepAlive::new()))
}
