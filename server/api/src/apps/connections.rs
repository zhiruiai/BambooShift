use super::{
    bridge, credentials,
    model::{self, Connection, PreparedCall},
    runtime::Authority,
    store, tool_access,
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, text},
    workspace::WorkspaceStore,
};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub async fn list(store: &WorkspaceStore) -> Result<Vec<Value>> {
    store::list_raw(store, "app_connections")
        .await?
        .into_iter()
        .map(|v| {
            serde_json::from_value::<Connection>(v)
                .map(|c| c.public())
                .map_err(|_| ApiError::new(409, "应用记录不可用。"))
        })
        .collect()
}
pub async fn tools(store: &WorkspaceStore, id: &str) -> Result<Vec<Value>> {
    Ok(tool_access::filter(&connected(store, id).await?))
}

pub(super) async fn managed_tools(store: &WorkspaceStore, id: &str) -> Result<Vec<Value>> {
    let saved = connected(store, id).await?;
    Ok(saved
        .tools
        .iter()
        .map(|tool| tool_access::project(&saved, tool))
        .collect())
}

async fn connected(store: &WorkspaceStore, id: &str) -> Result<Connection> {
    let saved = store::connection(store, id).await?;
    if saved.status != "connected" {
        return Err(ApiError::new(409, "应用尚未连接。"));
    }
    Ok(saved)
}
pub use super::endpoint::endpoint;

fn keys(body: &Value, allowed: &[&str]) -> Result<()> {
    if !body
        .as_object()
        .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str())))
    {
        return Err(ApiError::bad("应用连接参数无效。"));
    }
    Ok(())
}
pub async fn add(
    state: &State,
    store: &Arc<WorkspaceStore>,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    keys(body, &["name", "url", "authType", "token", "shared"])?;
    if body["shared"] != true {
        return Err(ApiError::bad("请确认与当前工作空间的 Bot 共享此应用。"));
    }
    let name = text(&body["name"], "应用名称", 80)?;
    if name.chars().any(char::is_control) {
        return Err(ApiError::bad("应用名称格式无效。"));
    }
    let url = endpoint(state, &body["url"])?;
    let auth = body["authType"]
        .as_str()
        .filter(|s| ["none", "bearer", "oauth"].contains(s))
        .ok_or_else(|| ApiError::bad("请选择应用认证方式。"))?;
    super::slack::validate_endpoint(&url, auth)?;
    let token = if auth == "bearer" {
        Some(model::secret(&body["token"], 4096)?)
    } else {
        if body.get("token").is_some_and(|v| !v.is_null() && v != "") {
            return Err(ApiError::bad("请只在凭据认证方式下保存访问凭据。"));
        }
        None
    };
    if token
        .as_ref()
        .is_some_and(|t| name.contains(t) || url.contains(t))
    {
        return Err(ApiError::bad("请只在访问凭据字段中填写凭据。"));
    }
    let lock = state
        .apps
        .lock(&format!("{}:connections", store.workspace_id))
        .await;
    let guard = lock.lock().await;
    authorize().await?;
    let existing = list(store).await?;
    if let Some(provider) = super::provider_catalog::for_endpoint(&url) {
        if existing.iter().any(|connection| {
            connection["url"]
                .as_str()
                .is_some_and(|url| provider.matches_endpoint(url))
        }) {
            return Err(
                ApiError::new(409, "此官方应用已有连接，请在应用设置中继续。")
                    .with_code("APP_CONNECTION_EXISTS"),
            );
        }
    }
    if existing.iter().any(|connection| connection["url"] == url) {
        return Err(
            ApiError::new(409, "此应用地址已有连接，请在应用设置中继续。")
                .with_code("APP_CONNECTION_EXISTS"),
        );
    }
    if existing.len() >= 20 || existing.iter().any(|c| c["name"] == name) {
        return Err(ApiError::new(
            409,
            "应用名称或地址已存在，或已达到 20 个应用上限。",
        ));
    }
    let mut saved = Connection {
        id: Uuid::new_v4().to_string(),
        name,
        url,
        revision: Uuid::new_v4().to_string(),
        auth_type: auth.into(),
        status: if auth == "oauth" {
            "needs_auth"
        } else {
            "disconnected"
        }
        .into(),
        tools: vec![],
        tool_controls: Default::default(),
        created_at: iso(now()),
        checked_at: None,
        error: None,
        credential_ref: None,
        authorization: None,
        revocation: None,
        refreshing: false,
        legacy_token: None,
        legacy_grant: None,
    };
    if let Some(token) = token {
        saved.credential_ref =
            Some(credentials::stage(store, &saved.id, &json!({"token":token})).await?);
    }
    authorize().await?;
    store::save_changed(state, store, &saved).await?;
    drop(guard);
    if auth == "oauth" {
        Ok(saved.public())
    } else {
        probe(state, store, saved, authorize).await
    }
}
pub async fn reconnect(
    state: &State,
    store: &Arc<WorkspaceStore>,
    id: &str,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    keys(body, &["token"])?;
    let lock = state
        .apps
        .lock(&format!("{}:{id}", store.workspace_id))
        .await;
    let guard = lock.lock().await;
    authorize().await?;
    let mut saved = store::connection(store, id).await?;
    let mut payload = credentials::payload(store, &saved)?;
    if saved.auth_type == "oauth" && (body.get("token").is_some() || !payload["grant"].is_object())
    {
        return Err(ApiError::new(409, "请使用网页登录授权来连接此应用。"));
    }
    if body.get("token").is_some() {
        super::slack::validate_endpoint(&saved.url, "bearer")?;
        payload = json!({"token":model::secret(&body["token"],4096)?});
        saved.auth_type = "bearer".into();
    }
    if saved.auth_type == "bearer" && payload["token"].as_str().is_none_or(str::is_empty) {
        return Err(ApiError::bad("请重新输入应用访问凭据。"));
    }
    let old = saved.credential_ref.clone();
    if payload.as_object().is_some_and(|m| !m.is_empty()) {
        saved.credential_ref = Some(credentials::stage(store, id, &payload).await?);
    }
    let force = saved.auth_type == "oauth" && saved.status == "needs_auth";
    saved.revision = Uuid::new_v4().to_string();
    saved.status = "disconnected".into();
    saved.refreshing = false;
    saved.tools.clear();
    saved.error = None;
    authorize().await?;
    store::save_changed(state, store, &saved).await?;
    if old != saved.credential_ref {
        credentials::remove(store, old.as_deref()).await?;
    }
    drop(guard);
    if force {
        super::tokens::access_token(state, store, &saved, authorize.clone(), true).await?;
        saved = store::connection(store, id).await?;
    }
    probe(state, store, saved, authorize).await
}
pub(crate) async fn check_revision(store: &WorkspaceStore, saved: &Connection) -> Result<()> {
    if store.is_closed() || store::connection(store, &saved.id).await?.revision != saved.revision {
        return Err(ApiError::new(409, "应用连接已更改，原操作已失效。"));
    }
    Ok(())
}
pub(crate) fn connection_authority(
    store: Arc<WorkspaceStore>,
    saved: Connection,
    authorize: Authority,
) -> Authority {
    Arc::new(move || {
        let store = store.clone();
        let saved = saved.clone();
        let authorize = authorize.clone();
        Box::pin(async move {
            authorize().await?;
            check_revision(&store, &saved).await
        })
    })
}
pub(crate) async fn probe(
    state: &State,
    store: &Arc<WorkspaceStore>,
    saved: Connection,
    authorize: Authority,
) -> Result<Value> {
    let authority = connection_authority(store.clone(), saved.clone(), authorize.clone());
    let outcome = async {
        let token =
            super::tokens::access_token(state, store, &saved, authority.clone(), false).await?;
        let payload = credentials::payload(store, &store::connection(store, &saved.id).await?)?;
        let result = bridge::run(
            state,
            json!({"op":"tools","endpoint":{"url":saved.url,"token":token}}),
            authority.clone(),
        )
        .await?;
        model::catalog(result, &credentials::secrets(&payload))
    }
    .await;
    let lock = state
        .apps
        .lock(&format!("{}:{}", store.workspace_id, saved.id))
        .await;
    let _guard = lock.lock().await;
    authority().await?;
    let mut current = store::connection(store, &saved.id).await?;
    current.checked_at = Some(iso(now()));
    match outcome {
        Ok(tools) => {
            current.status = "connected".into();
            current.tools = tools;
            current.error = None;
        }
        Err(error) => {
            current.status = if error.code == "APP_AUTH_REQUIRED" {
                "needs_auth"
            } else {
                "error"
            }
            .into();
            current.tools.clear();
            current.error = Some("应用连接失败，请检查服务地址、凭据或服务状态后重试。".into());
        }
    }
    store::save_changed(state, store, &current).await?;
    Ok(current.public())
}
pub async fn disconnect(
    state: &State,
    store: &Arc<WorkspaceStore>,
    id: &str,
    remove: bool,
    authorize: Authority,
) -> Result<Value> {
    let lock = state
        .apps
        .lock(&format!("{}:{id}", store.workspace_id))
        .await;
    let guard = lock.lock().await;
    authorize().await?;
    let mut saved = store::connection(store, id).await?;
    let payload = credentials::payload(store, &saved)?;
    let old = saved.credential_ref.take();
    saved.revision = Uuid::new_v4().to_string();
    saved.status = "disconnected".into();
    saved.refreshing = false;
    saved.tools.clear();
    saved.authorization = None;
    saved.legacy_token = None;
    saved.legacy_grant = None;
    saved.error = None;
    let grant = payload["grant"].clone();
    saved.revocation = if grant.is_object() {
        Some("pending".into())
    } else {
        None
    };
    if remove {
        sqlx::query("DELETE FROM app_connections WHERE id=?")
            .bind(id)
            .execute(&store.pool)
            .await?;
        store.emit("update", json!({}));
        state.changed(None, None, None);
        state.workspace.emit_all("update", json!({})).await;
    } else {
        store::save_changed(state, store, &saved).await?;
    }
    credentials::remove(store, old.as_deref()).await?;
    drop(guard);
    super::actions::cancel_connection(state, &store.workspace_id, id).await;
    if grant.is_object() {
        let state = state.clone();
        let store = store.clone();
        let id = id.to_owned();
        let revision = saved.revision.clone();
        tokio::spawn(async move {
            let result = bridge::run(&state, json!({"op":"revoke","grant":grant}), authorize).await;
            let lock = state
                .apps
                .lock(&format!("{}:{id}", store.workspace_id))
                .await;
            let _guard = lock.lock().await;
            if let Ok(mut current) = store::connection(&store, &id).await {
                if current.revision == revision {
                    current.revocation = Some(
                        match result {
                            Ok(v) if v["revoked"] == true => "revoked",
                            Ok(_) => "unavailable",
                            _ => "failed",
                        }
                        .into(),
                    );
                    let _ = store::save_changed(&state, &store, &current).await;
                }
            }
        });
    }
    Ok(if remove {
        json!({"ok":true})
    } else {
        saved.public()
    })
}
pub async fn prepare_call(
    store: &WorkspaceStore,
    id: &str,
    name: &str,
    args: &Value,
) -> Result<PreparedCall> {
    let mut tx = store.pool.begin().await?;
    let saved = store::connection_in(&mut tx, id)
        .await?
        .ok_or_else(|| ApiError::new(404, "应用记录不存在。"))?;
    if saved.status != "connected" {
        return Err(ApiError::new(
            409,
            "此应用尚未连接，请先由空间拥有者重新连接。",
        ));
    }
    let tool = saved
        .tools
        .iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| ApiError::new(404, "应用中没有此工具。"))?
        .clone();
    if !tool_access::enabled(&saved, name) {
        return Err(tool_access::disabled());
    }
    let tool_access_revision = tool_access::revision(&saved, name).map(str::to_owned);
    let schema_hash = tool_hash(&mut tx, id, name, &tool).await?;
    tx.commit().await?;
    let arguments = model::object(args, 16384)?;
    let payload = credentials::payload(store, &saved)?;
    if model::redact(arguments.to_string(), &credentials::secrets(&payload))
        != arguments.to_string()
    {
        return Err(ApiError::bad("应用参数不能包含连接凭据。"));
    }
    Ok(PreparedCall {
        connection_id: id.into(),
        connection_revision: saved.revision,
        app_name: saved.name,
        tool_name: name.into(),
        arguments,
        schema_hash,
        tool_access_revision,
        tool,
        expected_catalog: None,
    })
}
pub async fn execute(
    state: &State,
    store: &Arc<WorkspaceStore>,
    prepared: &PreparedCall,
    authorize: Authority,
) -> Result<Value> {
    let saved = store::connection(store, &prepared.connection_id).await?;
    let fresh = prepare_call(
        store,
        &prepared.connection_id,
        &prepared.tool_name,
        &prepared.arguments,
    )
    .await?;
    if !fresh.matches(prepared) {
        return Err(ApiError::new(409, "应用连接或工具已更改，原审批已失效。"));
    }
    let authority = tool_access::call_authority(store.clone(), prepared, authorize);
    let token = super::tokens::access_token(state, store, &saved, authority.clone(), false).await?;
    let payload = credentials::payload(store, &store::connection(store, &saved.id).await?)?;
    let result=bridge::run(state,json!({"op":"call","endpoint":{"url":saved.url,"token":token},"tool":prepared.tool,"arguments":prepared.arguments,"expectedCatalog":prepared.expected_catalog}),authority.clone()).await;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let lock = state
                .apps
                .lock(&format!("{}:{}", store.workspace_id, saved.id))
                .await;
            let _guard = lock.lock().await;
            if authority().await.is_ok() {
                if let Ok(mut current) = store::connection(store, &saved.id).await {
                    current.status = if error.code == "APP_AUTH_REQUIRED" {
                        "needs_auth"
                    } else {
                        "error"
                    }
                    .into();
                    current.tools.clear();
                    current.error =
                        Some("应用连接已失效或工具已变更，请刷新连接后重新确认。".into());
                    let _ = store::save_changed(state, store, &current).await;
                }
            }
            return Err(error);
        }
    };
    authority().await?;
    Ok(
        json!({"isError":result["isError"]==true,"text":model::redact(result["text"].as_str().unwrap_or("").to_owned(),&credentials::secrets(&payload))}),
    )
}

async fn tool_hash(
    tx: &mut sqlx::SqliteConnection,
    id: &str,
    name: &str,
    tool: &Value,
) -> Result<String> {
    let schema:Option<String>=sqlx::query_scalar("SELECT json_extract(t.value,'$.inputSchema') FROM app_connections c,json_each(c.data,'$.tools') t WHERE c.id=? AND json_extract(t.value,'$.name')=?")
        .bind(id).bind(name).fetch_optional(tx).await?;
    crate::shared_bots::tool_revision_with_schema(
        tool,
        &schema.ok_or_else(|| ApiError::new(409, "应用工具已变化。"))?,
    )
}
