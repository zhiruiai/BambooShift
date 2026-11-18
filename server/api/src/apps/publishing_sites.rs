use super::endpoint;
use crate::{
    db::State,
    error::{ApiError, Body, Result},
    workspace::{Table, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};

const SETTING: &str = "publishing-sites";
const MAX_CUSTOM: usize = 32;

fn presets() -> Vec<Value> {
    serde_json::from_str(include_str!("../../../../shared/publishing-sites.json"))
        .expect("valid built-in publishing sites")
}

fn custom_sites(row: Option<Value>) -> Result<Vec<Value>> {
    match row {
        None => Ok(Vec::new()),
        Some(row) => serde_json::from_value(row["sites"].clone())
            .map_err(|_| ApiError::new(500, "发布地址无法读取。")),
    }
}

pub async fn catalog(store: &WorkspaceStore) -> Result<Vec<Value>> {
    let mut sites = presets();
    sites.extend(custom_sites(store.get(Table::Settings, SETTING).await?)?);
    Ok(sites)
}

pub(super) async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, false, true).await?;
    let store = actor.store(&state).await?;
    let sites = catalog(&store).await?;
    actor.authorize(&state).await?;
    Ok(Json(json!(sites)))
}

fn parse_site(state: &State, body: Value) -> Result<Value> {
    if body.as_object().is_none_or(|o| o.len() != 2) {
        return Err(ApiError::bad("请提供平台名称与创作地址。"));
    }
    let name = body["name"].as_str().unwrap_or("").trim();
    if name.is_empty()
        || name.chars().count() > 64
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || " -_.·()（）&".contains(c))
    {
        return Err(ApiError::bad(
            "平台名称须为 1 至 64 个字，可包含文字、数字、空格和常用名称标点。",
        ));
    }
    if body["url"]
        .as_str()
        .is_some_and(|s| s.chars().any(|c| c.is_control() || c == '\\'))
    {
        return Err(ApiError::bad("请输入有效的公网 HTTPS 创作地址。"));
    }
    let address = endpoint::endpoint(state, &body["url"])?;
    let parsed =
        url::Url::parse(&address).map_err(|_| ApiError::bad("请输入公网 HTTPS 创作地址。"))?;
    let domain = parsed.domain().unwrap_or("").trim_end_matches('.');
    if parsed.scheme() != "https"
        || !domain.contains('.')
        || domain.ends_with(".local")
        || domain.ends_with(".localhost")
        || domain.ends_with(".internal")
        || domain.ends_with(".home.arpa")
        || domain.ends_with(".lan")
        || parsed.port().is_some()
    {
        return Err(ApiError::bad("请输入公网 HTTPS 创作地址。"));
    }
    if ["zhihu", "xiaohongshu"].contains(&name.to_ascii_lowercase().as_str())
        || presets().iter().any(|p| {
            p["url"] == address
                || p["name"]
                    .as_str()
                    .is_some_and(|n| n.to_lowercase() == name.to_lowercase())
        })
    {
        return Err(ApiError::bad("内置平台已在列表中。"));
    }
    Ok(json!({"name":name,"url":address}))
}

pub(super) async fn save(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    mutate(state, wid, headers, body, false).await
}
pub(super) async fn remove(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    mutate(state, wid, headers, body, true).await
}

async fn mutate(
    state: State,
    wid: String,
    headers: HeaderMap,
    body: Value,
    removing: bool,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let site = parse_site(&state, body)?;
    let store = actor.store(&state).await?;
    let mut tx = store.begin().await?;
    let mut sites = custom_sites(WorkspaceStore::get_in(&mut tx, Table::Settings, SETTING).await?)?;
    if removing {
        sites.retain(|v| v != &site);
    } else if !sites.contains(&site) {
        if sites.iter().any(|v| {
            v["name"].as_str().map(str::to_lowercase)
                == site["name"].as_str().map(str::to_lowercase)
                || v["url"] == site["url"]
        }) {
            return Err(ApiError::new(
                409,
                "这个名称或地址已存在。请移除旧地址后再保存。",
            ));
        }
        if sites.len() >= MAX_CUSTOM {
            return Err(ApiError::new(
                409,
                "工作空间最多可保存 32 个自定义发布地址。",
            ));
        }
        sites.push(site);
    }
    WorkspaceStore::put_in(
        &mut tx,
        Table::Settings,
        &json!({"id":SETTING,"sites":sites}),
    )
    .await?;
    actor.authorize(&state).await?;
    tx.commit().await?;
    let mut result = presets();
    result.extend(sites);
    Ok(Json(json!(result)))
}
