use super::{blueprint, installs};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
    workspace::{WorkspaceAccess, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};

pub async fn source(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.pool.begin().await?;
    let snapshot = blueprint::capture(&mut tx, &id).await?;
    let mut value = json!({"sourceRevision":snapshot.revision,"blueprint":snapshot.blueprint});
    if snapshot.avatar.is_some() {
        let agent =
            crate::workspace::mutations::find(&mut tx, crate::workspace::Table::Agents, &id)
                .await?;
        value["avatarPath"] = json!(format!(
            "/api/workspaces/{wid}/bot-avatars/{}",
            agent["avatarImageId"].as_str().unwrap()
        ));
    }
    tx.commit().await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn receipt(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    blueprint::uuid(&json!(id))?;
    let store = grant.store(&state).await?;
    let value = installs::saved(
        &mut *store.pool.acquire().await?,
        &installs::actor(&grant),
        &id,
        None,
    )
    .await?
    .ok_or_else(|| ApiError::new(404, "没有找到创建回执。"))?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn copy(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let operation = async {
        only_fields(
            &body,
            &[
                "requestId",
                "agentId",
                "expectedSourceRevision",
                "name",
                "routineMode",
            ],
        )?;
        let id = blueprint::uuid(&body["requestId"])?;
        let source =
            json!({"kind":"bot","id":body["agentId"],"revision":body["expectedSourceRevision"]});
        installs::install(
            state.clone(),
            grant.clone(),
            id.to_owned(),
            source,
            body["name"].clone(),
            body["routineMode"].clone(),
        )
        .await
    }
    .await;
    Ok((
        StatusCode::CREATED,
        Json(safe_error(&state, &grant, &body, operation).await?),
    ))
}
pub(super) async fn safe_error(
    state: &State,
    grant: &WorkspaceAccess,
    body: &Value,
    result: Result<Value>,
) -> Result<Value> {
    let Err(error) = result else { return result };
    if [400, 409, 413, 422].contains(&error.status.as_u16())
        && !state.is_closing()
        && blueprint::uuid(&body["requestId"]).is_ok()
    {
        grant.authorize_owner(state).await?;
        let store = grant.store(state).await?;
        let mut tx = store.begin().await?;
        let exists = sqlx::query("SELECT 1 FROM bot_install_receipts WHERE request_id=?")
            .bind(body["requestId"].as_str())
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        grant.authorize_owner(state).await?;
        tx.rollback().await?;
        if !exists
            && !store
                .bot_installs
                .pending(body["requestId"].as_str().unwrap())
        {
            return Err(error.with_code("BOT_INSTALL_NOT_STARTED"));
        }
    }
    Err(error)
}
