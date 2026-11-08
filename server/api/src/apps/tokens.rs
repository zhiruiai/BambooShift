use super::model::Connection;
use super::{
    bridge,
    connections::{check_revision, connection_authority},
    credentials,
    runtime::Authority,
    store,
};
use crate::{
    db::{State, now},
    error::{ApiError, Result},
    workspace::WorkspaceStore,
};
use serde_json::json;
use std::sync::Arc;

pub(crate) async fn access_token(
    state: &State,
    store: &Arc<WorkspaceStore>,
    saved: &Connection,
    authorize: Authority,
    force: bool,
) -> Result<Option<String>> {
    let lock = state
        .apps
        .lock(&format!("{}:{}:refresh", store.workspace_id, saved.id))
        .await;
    let _guard = lock.lock().await;
    let connection_lock = state
        .apps
        .lock(&format!("{}:{}", store.workspace_id, saved.id))
        .await;
    let connection_guard = connection_lock.lock().await;
    authorize().await?;
    check_revision(store, saved).await?;
    let mut current = store::connection(store, &saved.id).await?;
    let payload = credentials::payload(store, &current)?;
    super::slack::validate_grant(&current.url, &current.auth_type, &payload["grant"])?;
    if current.auth_type != "oauth" {
        let token = payload["token"].as_str().map(str::to_owned);
        if current.auth_type == "bearer" && token.as_ref().is_none_or(String::is_empty) {
            return Err(
                ApiError::new(409, "来源应用凭据不可用，请由拥有者重新连接。")
                    .with_code("APP_AUTH_REQUIRED"),
            );
        }
        return Ok(token);
    }
    let grant = &payload["grant"];
    if !grant.is_object() {
        return Err(ApiError::new(409, "请重新进行网页登录授权。").with_code("APP_AUTH_REQUIRED"));
    }
    if !force
        && grant["expiresAt"]
            .as_i64()
            .is_none_or(|expiry| expiry > now() + 60_000)
    {
        return Ok(grant["tokens"]["access_token"].as_str().map(str::to_owned));
    }
    current.refreshing = true;
    store::save_changed(state, store, &current).await?;
    drop(connection_guard);
    // A credential refresh is shared by the connection and may rotate its token.
    // Finish the admitted refresh even if its caller loses one tool's permission.
    let refresh_authority = connection_authority(
        store.clone(),
        saved.clone(),
        Arc::new(|| Box::pin(async { Ok(()) })),
    );
    let result = bridge::run(
        state,
        json!({"op":"refresh","grant":grant}),
        refresh_authority,
    )
    .await;
    let _connection_guard = connection_lock.lock().await;
    check_revision(store, saved).await?;
    let mut current = store::connection(store, &saved.id).await?;
    let old = current.credential_ref.take();
    current.refreshing = false;
    current.legacy_token = None;
    current.legacy_grant = None;
    let token = match result {
        Ok(grant)
            if super::slack::validate_grant(&current.url, &current.auth_type, &grant).is_ok() =>
        {
            current.authorization =
                Some(json!({"issuer":grant["issuer"],"scopes":grant["scopes"]}));
            let token = grant["tokens"]["access_token"]
                .as_str()
                .ok_or_else(|| ApiError::new(502, "应用授权响应无效。"))?
                .to_owned();
            current.credential_ref =
                Some(credentials::stage(store, &current.id, &json!({"grant":grant})).await?);
            Some(token)
        }
        _ => {
            current.status = "needs_auth".into();
            current.tools.clear();
            current.authorization = None;
            current.error = Some("授权刷新结果未确认，请重新进行网页登录授权。".into());
            None
        }
    };
    store::save_changed(state, store, &current).await?;
    credentials::remove(store, old.as_deref()).await?;
    authorize().await?;
    token
        .map(Some)
        .ok_or_else(|| ApiError::new(409, "应用需要重新授权。").with_code("APP_AUTH_REQUIRED"))
}
