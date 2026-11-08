use super::{Table, WorkspaceStore, access};
use crate::{
    db::State,
    error::{ApiError, Body, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

const PREFIX: &str = "model-profile:";
const SECRET: &str = "model-profile-secret:";
pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    let old = WorkspaceStore::get_in(conn, Table::Settings, "model")
        .await?
        .unwrap_or(json!({}));
    if let Some(id) = old["profileId"].as_str() {
        if WorkspaceStore::get_in(conn, Table::Settings, &format!("{PREFIX}{id}"))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let provider = old["provider"].as_str().unwrap_or("anthropic");
    let model = old["model"].as_str().unwrap_or("claude-sonnet-4-5");
    let profile = json!({"id":format!("{PREFIX}{id}"),"name":format!("{provider} · {model}"),"provider":provider,"model":model,"baseUrl":old["baseUrl"].as_str().unwrap_or(""),"vision":old["vision"]==true});
    WorkspaceStore::put_in(conn, Table::Settings, &profile).await?;
    let mut active = profile.clone();
    active["id"] = json!("model");
    active["profileId"] = json!(id);
    WorkspaceStore::put_in(conn, Table::Settings, &active).await?;
    if let Some(secret) = WorkspaceStore::get_in(conn, Table::Settings, "secrets").await? {
        if secret["provider"] == profile["provider"] && secret["apiKey"].is_string() {
            WorkspaceStore::put_in(conn,Table::Settings,&json!({"id":format!("{SECRET}{id}"),"provider":provider,"baseUrl":profile["baseUrl"],"apiKey":secret["apiKey"]})).await?;
            WorkspaceStore::delete_in(conn, Table::Settings, "secrets").await?;
        }
    }
    Ok(())
}
async fn profile(conn: &mut SqliteConnection, id: &str) -> Result<Value> {
    WorkspaceStore::get_in(conn, Table::Settings, &format!("{PREFIX}{id}"))
        .await?
        .ok_or_else(|| ApiError::new(404, "模型配置不存在。"))
}
async fn public(store: &WorkspaceStore, conn: &mut SqliteConnection, id: &str) -> Result<Value> {
    let saved = profile(conn, id).await?;
    let mut p = json!({"id":id,"name":saved["name"],"provider":saved["provider"],"model":saved["model"],"baseUrl":saved["baseUrl"],"vision":saved["vision"]==true});
    let has = !super::credentials::key(store, id, &saved)?.is_empty();
    p["id"] = json!(id);
    p["hasApiKey"] = json!(has);
    p["configured"] = json!(has || p["baseUrl"].as_str().is_some_and(|s| !s.is_empty()));
    p["credentialSource"] = json!(if has { "saved" } else { "none" });
    Ok(p)
}
pub async fn settings(store: &WorkspaceStore, conn: &mut SqliteConnection) -> Result<Value> {
    let active = WorkspaceStore::get_in(conn, Table::Settings, "model")
        .await?
        .ok_or_else(|| ApiError::new(409, "请先配置模型。"))?;
    let p = public(store, conn, active["profileId"].as_str().unwrap_or("")).await?;
    Ok(
        json!({"profileId":p["id"],"profileName":p["name"],"provider":p["provider"],"model":p["model"],"baseUrl":p["baseUrl"],"vision":p["vision"],"hasApiKey":p["hasApiKey"],"configured":p["configured"],"runtime":"pi","workspace":"workspace","language":"zh-CN"}),
    )
}
/** Server-only credential snapshot for a single authenticated workspace run. */
pub async fn runtime_config(store: &WorkspaceStore) -> Result<Value> {
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.pool.begin().await?;
    let mut config = settings(store, &mut tx).await?;
    let id = config["profileId"].as_str().unwrap_or("");
    let p = profile(&mut tx, id).await?;
    config["apiKey"] = json!(super::credentials::key(store, id, &p)?);
    tx.commit().await?;
    Ok(config)
}
/// Resolve a selected saved model; credentials stay inside the backend execution path.
pub async fn runtime_profile_config(store: &WorkspaceStore, id: &str) -> Result<Value> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(ApiError::bad("模型配置标识无效。"));
    }
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.pool.begin().await?;
    let config = runtime_profile_config_in(store, &mut tx, id).await?;
    tx.commit().await?;
    Ok(config)
}

/// The caller holds credential_lock before opening its transaction.
pub(crate) async fn runtime_profile_config_in(
    store: &WorkspaceStore,
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Value> {
    let saved = profile(conn, id).await?;
    let mut config = public(store, conn, id).await?;
    config["profileId"] = json!(id);
    config["apiKey"] = json!(super::credentials::key(store, id, &saved)?);
    Ok(config)
}

async fn listing(store: &WorkspaceStore, conn: &mut SqliteConnection) -> Result<Value> {
    let active = WorkspaceStore::get_in(conn, Table::Settings, "model")
        .await?
        .unwrap_or_default();
    let mut profiles = Vec::new();
    for value in WorkspaceStore::list_in(conn, Table::Settings).await? {
        if let Some(id) = value["id"].as_str().and_then(|id| id.strip_prefix(PREFIX)) {
            profiles.push(public(store, conn, id).await?);
        }
    }
    Ok(json!({"activeProfileId":active["profileId"],"profiles":profiles}))
}
fn endpoint(value: &Value) -> Result<String> {
    let text = value
        .as_str()
        .ok_or_else(|| ApiError::bad("模型地址必须为文本。"))?
        .trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let url = url::Url::parse(text).map_err(|_| ApiError::bad("模型地址无效。"))?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::bad("模型地址不能包含登录信息、查询参数或片段。"));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
async fn save(
    store: &WorkspaceStore,
    conn: &mut SqliteConnection,
    body: &Value,
    legacy: bool,
) -> Result<Value> {
    crate::error::only_fields(
        body,
        &[
            "id",
            "profileId",
            "name",
            "provider",
            "model",
            "baseUrl",
            "vision",
            "apiKey",
            "activate",
            "clearApiKey",
            "saveAsNew",
        ],
    )?;
    let active = WorkspaceStore::get_in(conn, Table::Settings, "model")
        .await?
        .unwrap_or_default();
    for field in ["activate", "clearApiKey", "saveAsNew"] {
        if body.get(field).is_some_and(|v| !v.is_boolean()) {
            return Err(ApiError::bad("模型配置选项无效。"));
        }
    }
    for field in ["id", "profileId"] {
        if body.get(field).is_some_and(|v| !v.is_string()) {
            return Err(ApiError::bad("模型配置标识无效。"));
        }
    }
    let selected = if legacy && body["saveAsNew"] == true {
        None
    } else {
        body["id"]
            .as_str()
            .or_else(|| body["profileId"].as_str())
            .or_else(|| {
                if legacy {
                    active["profileId"].as_str()
                } else {
                    None
                }
            })
    };
    let id = selected
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let old = if selected.is_some() {
        profile(conn, &id).await?
    } else {
        json!({"provider":"anthropic","model":"claude-sonnet-4-5","baseUrl":"","vision":false})
    };
    let mut p = old.clone();
    p["id"] = json!(format!("{PREFIX}{id}"));
    for (field, max) in [("name", 80), ("provider", 80), ("model", 200)] {
        if let Some(value) = body.get(field) {
            p[field] = json!(crate::error::text(value, field, max)?);
        }
    }
    if p["name"].is_null() {
        p["name"] = json!(format!(
            "{} · {}",
            p["provider"].as_str().unwrap_or(""),
            p["model"].as_str().unwrap_or("")
        ));
    }
    if !p["provider"].as_str().is_some_and(|v| {
        !v.is_empty()
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }) {
        return Err(ApiError::bad("模型服务标识无效。"));
    }
    if old["provider"] != p["provider"] && body.get("baseUrl").is_none() {
        p["baseUrl"] = json!("");
    }
    if let Some(value) = body.get("baseUrl") {
        p["baseUrl"] = json!(endpoint(value)?);
    }
    if let Some(value) = body.get("vision") {
        if !value.is_boolean() {
            return Err(ApiError::bad("图片能力选项无效。"));
        }
        p["vision"] = value.clone();
    }
    let clear = body["clearApiKey"] == true
        || old["provider"] != p["provider"]
        || old["baseUrl"] != p["baseUrl"];
    if clear {
        p.as_object_mut().unwrap().remove("credentialRef");
    }
    if let Some(key) = body.get("apiKey") {
        let key = key
            .as_str()
            .filter(|k| k.len() <= 16384 && !k.contains(['\r', '\n', '\0']))
            .ok_or_else(|| ApiError::bad("模型密钥格式无效。"))?
            .trim();
        if !key.is_empty() && body["clearApiKey"] == true {
            return Err(ApiError::bad("不能同时填写和清除模型密钥。"));
        }
        if !key.is_empty() {
            p["credentialRef"] = json!(super::credentials::stage(
                store,
                &id,
                &p["provider"],
                &p["baseUrl"],
                key
            )?);
        }
    }
    WorkspaceStore::put_in(conn, Table::Settings, &p).await?;
    if legacy || body["activate"] == true || active["profileId"] == id {
        let mut next = p.clone();
        next["id"] = json!("model");
        next["profileId"] = json!(id);
        WorkspaceStore::put_in(conn, Table::Settings, &next).await?;
    }
    Ok(json!({"profile":public(store,conn,&id).await?,"settings":settings(store,conn).await?}))
}
pub async fn get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, false).await?;
    let store = grant.store(&state).await?;
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.pool.begin().await?;
    let data = listing(&store, &mut tx).await?;
    tx.commit().await?;
    grant.authorize(&state).await?;
    Ok(Json(data))
}
pub async fn post(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let status = if body.get("id").is_some() {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(mutate(&state, &headers, &wid, &body, false).await?),
    ))
}
pub async fn put_settings(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    Ok(Json(
        mutate(&state, &headers, &wid, &body, true).await?["settings"].clone(),
    ))
}
async fn mutate(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
    body: &Value,
    legacy: bool,
) -> Result<Value> {
    let grant = access::require(state, headers, wid, true, true).await?;
    let store = grant.store(state).await?;
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.begin().await?;
    super::mutations::assert_idle(&state, &mut tx, &wid).await?;
    let value = save(&store, &mut tx, body, legacy).await?;
    grant.authorize(state).await?;
    tx.commit().await?;
    super::credentials::collect(&store).await?;
    store.emit("update", json!({}));
    grant.authorize(state).await?;
    Ok(value)
}
pub async fn activate(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    super::mutations::assert_idle(&state, &mut tx, &wid).await?;
    let mut p = profile(&mut tx, &id).await?;
    p["id"] = json!("model");
    p["profileId"] = json!(id);
    WorkspaceStore::put_in(&mut tx, Table::Settings, &p).await?;
    let value = settings(&store, &mut tx).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(Json(value))
}
pub async fn remove(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.begin().await?;
    super::mutations::assert_idle(&state, &mut tx, &wid).await?;
    profile(&mut tx, &id).await?;
    let active = WorkspaceStore::get_in(&mut tx, Table::Settings, "model")
        .await?
        .unwrap_or_default();
    if active["profileId"] == id {
        return Err(ApiError::new(409, "请先切换其他模型配置，再删除此配置。"));
    }
    WorkspaceStore::delete_in(&mut tx, Table::Settings, &format!("{PREFIX}{id}")).await?;
    WorkspaceStore::delete_in(&mut tx, Table::Settings, &format!("{SECRET}{id}")).await?;
    let value = json!({"ok":true});
    grant.authorize(&state).await?;
    tx.commit().await?;
    super::credentials::collect(&store).await?;
    store.emit("update", json!({}));
    Ok(Json(value))
}
