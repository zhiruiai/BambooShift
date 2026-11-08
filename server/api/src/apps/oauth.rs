use super::{
    bridge, connections, credentials, model, oauth_store as flow,
    runtime::{Authority, user_authority},
    store,
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub async fn current(
    state: &State,
    store: &WorkspaceStore,
    actor: &WorkspaceAccess,
    cid: &str,
) -> Result<Value> {
    let records = store::list_raw(store, "app_oauth_flows").await?;
    for record in records.into_iter().rev() {
        if record["flow"]["connectionId"] == cid
            && record["initiatorSessionId"] == actor.session_id
            && record["ownerId"] == actor.user_id
        {
            return flow::view(
                state,
                store,
                actor,
                cid,
                record["id"].as_str().unwrap_or(""),
                false,
            )
            .await;
        }
    }
    Ok(Value::Null)
}
pub async fn start(
    state: &State,
    store: &Arc<WorkspaceStore>,
    actor: &WorkspaceAccess,
    cid: &str,
    body: &Value,
) -> Result<Value> {
    if !body.as_object().is_some_and(|m| {
        m.keys()
            .all(|k| ["expectedRevision", "clientId", "clientSecret"].contains(&k.as_str()))
    }) {
        return Err(ApiError::bad("授权参数无效。"));
    }
    for key in ["clientId", "clientSecret"] {
        if body.get(key).is_some() {
            model::secret(&body[key], 4096)?;
        }
    }
    let admission = state
        .apps
        .lock(&format!("oauth-admission:{}", store.workspace_id))
        .await;
    let admission = admission.lock().await;
    let lock = state
        .apps
        .lock(&format!("{}:{cid}", store.workspace_id))
        .await;
    let guard = lock.lock().await;
    actor.authorize_owner(state).await?;
    let mut connection = store::connection(store, cid).await?;
    if connection.auth_type != "oauth" || body["expectedRevision"] != connection.revision {
        return Err(ApiError::new(409, "应用连接已更改，请重新查看后授权。"));
    }
    let origin = flow::origin(state);
    super::slack::validate_setup(&connection.url, &origin, body)?;
    let records = store::list_raw(store, "app_oauth_flows").await?;
    let mut active = 0;
    for record in records {
        if !flow::terminal(&record["flow"]) {
            let id = record["id"].as_str().unwrap_or("");
            let flow_lock = state.apps.lock(&format!("oauth:{id}")).await;
            let _flow_guard = flow_lock.lock().await;
            let mut record = store::get_raw(store, "app_oauth_flows", id).await?;
            if flow::terminal(&record["flow"]) {
                continue;
            }
            if flow::valid(
                state,
                store,
                &record,
                record.get("browserSessionId").is_some(),
            )
            .await
            .is_err()
            {
                flow::end(
                    store,
                    &mut record,
                    "cancelled",
                    Some("授权已失效，请重新开始。"),
                )
                .await?;
                continue;
            }
            active += 1;
            if record["flow"]["connectionId"] == cid {
                return Err(ApiError::new(
                    409,
                    "此应用已有授权正在进行，请先继续或取消。",
                ));
            }
        }
    }
    if active >= 8 {
        return Err(ApiError::new(429, "进行中的授权过多，请稍后再试。"));
    }
    let old = connection.credential_ref.take();
    connection.revision = Uuid::new_v4().to_string();
    connection.tools.clear();
    connection.status = "needs_auth".into();
    connection.authorization = None;
    connection.legacy_token = None;
    connection.legacy_grant = None;
    connection.error = None;
    store::save_changed(state, store, &connection).await?;
    credentials::remove(store, old.as_deref()).await?;
    let id = Uuid::new_v4().to_string();
    let state_token = flow::token();
    let mut record = json!({"id":id,"ownerId":actor.user_id,"storageKey":actor.storage_key,"initiatorSessionId":actor.session_id,"stateHash":flow::digest(&state_token),"flow":{"id":id,"connectionId":cid,"connectionRevision":connection.revision,"appName":connection.name,"status":"preparing","expiresAt":iso(now()+600_000),"scopes":[]}});
    flow::save(store, &record).await?;
    sqlx::query("INSERT INTO app_oauth_index VALUES(?,?,?,?)")
        .bind(&id)
        .bind(&store.workspace_id)
        .bind(&actor.storage_key)
        .bind(flow::digest(&state_token))
        .execute(&state.pool)
        .await?;
    drop(guard);
    drop(admission);
    let redirect = format!("{origin}{}", flow::CALLBACK);
    let mut input = json!({"url":connection.url,"redirectUri":redirect,"state":state_token});
    if origin.starts_with("https:") {
        input["clientMetadataUrl"] = json!(format!("{origin}/api/app-oauth/client-metadata"));
    }
    for key in ["clientId", "clientSecret"] {
        if let Some(value) = body.get(key) {
            input[key] = value.clone();
        }
    }
    let result = bridge::run(
        state,
        json!({"op":"prepare","input":input}),
        authority(state, store, &id, false),
    )
    .await;
    let lock = state.apps.lock(&format!("oauth:{id}")).await;
    let _guard = lock.lock().await;
    record = store::get_raw(store, "app_oauth_flows", &id).await?;
    if record["flow"]["status"] != "preparing" {
        return Ok(record["flow"].clone());
    }
    match result {
        Ok(prepared)
            if prepared["state"] == state_token
                && prepared["redirectUri"] == redirect
                && flow::valid(state, store, &record, false).await.is_ok() =>
        {
            record["privateRef"] =
                json!(credentials::stage(store, &id, &json!({"prepared":prepared})).await?);
            record["flow"]["status"] = json!("pending");
            record["flow"]["authorizationOrigin"] = json!(
                url::Url::parse(prepared["authorizationUrl"].as_str().unwrap_or(""))
                    .map_err(|_| ApiError::new(502, "授权响应无效。"))?
                    .origin()
                    .ascii_serialization()
            );
            record["flow"]["issuer"] = prepared["issuer"].clone();
            record["flow"]["scopes"] = prepared["scopes"].clone();
            record["flow"]["launchPath"] =
                json!(format!("/app-authorize/{}/{cid}/{id}", store.workspace_id));
            flow::save(store, &record).await?;
        }
        _ => {
            flow::end(
                store,
                &mut record,
                "error",
                Some("无法准备网页登录授权，请检查应用及客户端配置后重试。"),
            )
            .await?
        }
    }
    Ok(record["flow"].clone())
}
pub fn authority(state: &State, store: &Arc<WorkspaceStore>, id: &str, browser: bool) -> Authority {
    let state = state.clone();
    let store = store.clone();
    let id = id.to_owned();
    Arc::new(move || {
        let state = state.clone();
        let store = store.clone();
        let id = id.clone();
        Box::pin(async move {
            let record = store::get_raw(&store, "app_oauth_flows", &id).await?;
            flow::valid(&state, &store, &record, browser).await
        })
    })
}
pub async fn begin(
    state: &State,
    store: &Arc<WorkspaceStore>,
    actor: &WorkspaceAccess,
    cid: &str,
    id: &str,
) -> Result<(Value, String)> {
    let lock = state.apps.lock(&format!("oauth:{id}")).await;
    let _guard = lock.lock().await;
    let mut record = flow::authorize(state, store, actor, cid, id, true).await?;
    if record["flow"]["status"] != "pending" || record.get("browserSessionId").is_some() {
        return Err(ApiError::new(
            409,
            "授权已经开始或失效，请回到原窗口查看状态。",
        ));
    }
    let private = credentials::read(store, id, record["privateRef"].as_str())?;
    let nonce = flow::token();
    record["browserSessionId"] = json!(actor.session_id);
    record["cookieHash"] = json!(flow::digest(&nonce));
    flow::save(store, &record).await?;
    Ok((
        json!({"authorizationUrl":private["prepared"]["authorizationUrl"]}),
        flow::cookie(state, id, &nonce, 600),
    ))
}
pub async fn finish(
    state: &State,
    store: &Arc<WorkspaceStore>,
    actor: &WorkspaceAccess,
    cid: &str,
    id: &str,
) -> Result<Value> {
    let lock = state.apps.lock(&format!("oauth:{id}")).await;
    let guard = lock.lock().await;
    let mut record = flow::authorize(state, store, actor, cid, id, false).await?;
    if record["flow"]["status"] == "complete" {
        return Ok(record["flow"].clone());
    }
    if record["flow"]["status"] != "callback_received" {
        return Err(ApiError::new(409, "尚未收到有效授权回调，或此授权已结束。"));
    }
    flow::valid(state, store, &record, true).await?;
    let private = credentials::read(store, id, record["privateRef"].as_str())?;
    record["flow"]["status"] = json!("exchanging");
    flow::save(store, &record).await?;
    drop(guard);
    let authorize = authority(state, store, id, true);
    let result = bridge::run(
        state,
        json!({"op":"exchange","prepared":private["prepared"],"code":private["code"]}),
        authorize.clone(),
    )
    .await;
    let lock = state
        .apps
        .lock(&format!("{}:{cid}", store.workspace_id))
        .await;
    let _connection_guard = lock.lock().await;
    let lock = state.apps.lock(&format!("oauth:{id}")).await;
    let guard = lock.lock().await;
    record = store::get_raw(store, "app_oauth_flows", id).await?;
    if record["flow"]["status"] != "exchanging" {
        return Ok(record["flow"].clone());
    }
    let mut committed = None;
    if let Ok(grant) = result {
        if authorize().await.is_ok() {
            let mut connection = store::connection(store, cid).await?;
            if super::slack::validate_grant(&connection.url, &connection.auth_type, &grant).is_ok()
            {
                let old = connection.credential_ref.take();
                connection.credential_ref =
                    Some(credentials::stage(store, cid, &json!({"grant":grant})).await?);
                connection.authorization =
                    Some(json!({"issuer":grant["issuer"],"scopes":grant["scopes"]}));
                connection.status = "disconnected".into();
                store::save_changed(state, store, &connection).await?;
                credentials::remove(store, old.as_deref()).await?;
                committed = Some(connection);
            }
        }
    }
    if let Some(connection) = committed {
        flow::end(store, &mut record, "complete", None).await?;
        drop(guard);
        drop(_connection_guard);
        let _ = connections::probe(state, store, connection, user_authority(state, actor)).await;
    } else {
        flow::end(
            store,
            &mut record,
            "error",
            Some("授权未能确认完成，请重新开始；不会自动重试兑换。"),
        )
        .await?;
    }
    Ok(record["flow"].clone())
}
pub async fn cancel(
    state: &State,
    store: &WorkspaceStore,
    actor: &WorkspaceAccess,
    cid: &str,
    id: &str,
) -> Result<Value> {
    let lock = state.apps.lock(&format!("oauth:{id}")).await;
    let _guard = lock.lock().await;
    let mut record = flow::authorize(state, store, actor, cid, id, false).await?;
    if !flow::terminal(&record["flow"]) {
        flow::end(store, &mut record, "cancelled", Some("授权已取消。")).await?;
    }
    Ok(record["flow"].clone())
}
