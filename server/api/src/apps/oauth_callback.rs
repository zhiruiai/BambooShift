use super::{credentials, oauth_store as flow, store};
use crate::{
    db::State,
    error::{ApiError, Result},
};
use axum::{
    extract::{RawQuery, State as Extract},
    http::{HeaderMap, header},
    response::{Html, IntoResponse, Response},
};
use serde_json::json;
use sqlx::Row;

pub async fn callback(
    Extract(state): Extract<State>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Result<Response> {
    let raw = raw.unwrap_or_default();
    if raw.len() > 16384 {
        return Err(ApiError::bad("授权回调无效。"));
    }
    let mut query = std::collections::HashMap::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        if key.len() > 128 || query.insert(key.into_owned(), value.into_owned()).is_some() {
            return Err(ApiError::bad("授权回调无效。"));
        }
    }
    let token = query
        .get("state")
        .filter(|s| {
            s.len() == 43
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        .ok_or_else(|| ApiError::bad("授权回调无效。"))?;
    let code = query
        .get("code")
        .filter(|s| !s.is_empty() && s.len() <= 4096);
    let error = query
        .get("error")
        .filter(|s| !s.is_empty() && s.len() <= 200);
    if code.is_some() == error.is_some() {
        return Err(ApiError::bad("授权回调无效。"));
    }
    let index =
        sqlx::query("SELECT id,workspace_id,storage_key FROM app_oauth_index WHERE state_hash=?")
            .bind(flow::digest(token))
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::bad("授权回调已失效。"))?;
    let id: String = index.get("id");
    let wid: String = index.get("workspace_id");
    let key: String = index.get("storage_key");
    let store = state.workspace.get(&wid, &key).await?;
    let lock = state.apps.lock(&format!("oauth:{id}")).await;
    let _guard = lock.lock().await;
    let mut record = store::get_raw(&store, "app_oauth_flows", &id).await?;
    let name = flow::cookie_name(&state, &id);
    let cookies: Vec<_> = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .map(str::trim)
        .filter_map(|c| c.strip_prefix(&format!("{name}=")))
        .collect();
    if cookies.len() != 1
        || record["cookieHash"].as_str() != Some(flow::digest(cookies[0]).as_str())
        || record["flow"]["status"] != "pending"
        || record["stateHash"] != flow::digest(token)
    {
        return Err(ApiError::bad("请使用开始网页登录授权的浏览器完成回调。"));
    }
    flow::valid(&state, &store, &record, true).await?;
    let mut private = credentials::read(&store, &id, record["privateRef"].as_str())?;
    let issuer = query.get("iss");
    if (private["prepared"]["metadata"]["authorization_response_iss_parameter_supported"] == true
        && issuer.is_none())
        || issuer.is_some_and(|s| private["prepared"]["issuer"] != *s)
    {
        return Err(ApiError::bad("授权服务来源不匹配。"));
    }
    let count =
        sqlx::query("UPDATE app_oauth_index SET state_hash=NULL WHERE id=? AND state_hash=?")
            .bind(&id)
            .bind(flow::digest(token))
            .execute(&state.pool)
            .await?
            .rows_affected();
    if count != 1 {
        return Err(ApiError::bad("授权回调已失效。"));
    }
    record.as_object_mut().unwrap().remove("stateHash");
    record.as_object_mut().unwrap().remove("cookieHash");
    if error.is_some() {
        flow::end(
            &store,
            &mut record,
            "error",
            Some("应用授权未完成，请回到原窗口重新开始。"),
        )
        .await?;
    } else {
        private["code"] = json!(code);
        private["prepared"]["state"] = json!("");
        let old = record["privateRef"].as_str().map(str::to_owned);
        record["privateRef"] = json!(credentials::stage(&store, &id, &private).await?);
        record["flow"]["status"] = json!("callback_received");
        record["flow"].as_object_mut().unwrap().remove("launchPath");
        flow::save(&store, &record).await?;
        credentials::remove(&store, old.as_deref()).await?;
    }
    let mut response = (
        axum::http::StatusCode::SEE_OTHER,
        [(header::LOCATION, flow::RESULT)],
    )
        .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        flow::cookie(&state, &id, "", 0).parse().unwrap(),
    );
    Ok(response)
}
pub async fn result() -> Html<&'static str> {
    Html(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>PandaMate 授权</title><main><h1>已返回 PandaMate</h1><p>请回到发起授权的窗口，查看结果并点击完成连接。</p><p>Return to the original PandaMate window to review and finish connecting.</p></main></html>",
    )
}
pub async fn metadata(Extract(state): Extract<State>) -> axum::Json<serde_json::Value> {
    let origin = flow::origin(&state);
    axum::Json(
        json!({"client_id":format!("{origin}/api/app-oauth/client-metadata"),"client_name":"PandaMate","redirect_uris":[format!("{origin}{}",flow::CALLBACK)],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}),
    )
}
