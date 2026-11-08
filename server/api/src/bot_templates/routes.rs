use super::{blueprint, mutations, projection, store};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
    workspace::{WorkspaceAccess, access},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn router() -> Router<State> {
    use axum::routing::{get, post};
    Router::new()
        .merge(super::public_routes::router())
        .route(
            "/api/workspaces/{wid}/bot-templates",
            get(list).post(create),
        )
        .route(
            "/api/workspaces/{wid}/bot-templates/{id}",
            get(get_one).patch(edit),
        )
        .route(
            "/api/workspaces/{wid}/bot-templates/{id}/refresh",
            post(refresh),
        )
        .route(
            "/api/workspaces/{wid}/bot-templates/{id}/publish",
            post(publish),
        )
        .route(
            "/api/workspaces/{wid}/bot-templates/{id}/revoke",
            post(revoke),
        )
        .route("/api/workspaces/{wid}/bot-templates/{id}/sync", post(sync))
        .route(
            "/api/workspaces/{wid}/bot-templates/{id}/avatar",
            get(super::public_routes::draft_avatar),
        )
        .route(
            "/api/workspaces/{wid}/bot-sharing-policy",
            get(policy_get).put(policy_put),
        )
        .route(
            "/api/workspaces/{wid}/bot-template-imports",
            post(super::public_routes::import),
        )
        .route(
            "/api/workspaces/{wid}/bot-template-imports/{id}",
            get(super::copy_routes::receipt),
        )
        .layer(DefaultBodyLimit::max(3 * 1024 * 1024))
}
pub async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let mut conn = state.bot_templates.pool.acquire().await?;
    let values = if let Some(id) = query.get("requestId") {
        blueprint::uuid(&json!(id))?;
        store::prior(&mut conn, &grant, id, None)
            .await?
            .map(|v| vec![store::view(&v.row)])
            .unwrap_or_default()
    } else {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM templates WHERE workspace_id=? ORDER BY rowid DESC",
        )
        .bind(&wid)
        .fetch_all(&mut *conn)
        .await?;
        let mut values = Vec::new();
        for id in ids {
            values.push(store::view(&store::read(&mut conn, &wid, &id).await?.row));
        }
        values
    };
    grant.authorize_owner(&state).await?;
    Ok(Json(json!(values)))
}
pub async fn get_one(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let value = store::view(
        &store::read(&mut *state.bot_templates.pool.acquire().await?, &wid, &id)
            .await?
            .row,
    );
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn create(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        Json(change(&state, &headers, &wid, None, "create", &body).await?),
    ))
}
macro_rules! mutation_route {
    ($name:ident,$op:literal) => {
        pub async fn $name(
            Extract(state): Extract<State>,
            Path((wid, id)): Path<(String, String)>,
            headers: HeaderMap,
            Body(body): Body,
        ) -> Result<Json<Value>> {
            Ok(Json(
                change(&state, &headers, &wid, Some(&id), $op, &body).await?,
            ))
        }
    };
}
mutation_route!(edit, "edit");
mutation_route!(refresh, "refresh");
mutation_route!(publish, "publish");
mutation_route!(revoke, "revoke");
async fn change(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
    id: Option<&str>,
    operation: &str,
    body: &Value,
) -> Result<Value> {
    let grant = access::require(state, headers, wid, true, true).await?;
    let value = match mutations::apply(state, &grant, operation, id, body).await {
        Ok(v) => v,
        Err(e) => return Err(safe_error(state, &grant, body, e).await?),
    };
    projection::repair(state, &grant, value["id"].as_str().unwrap()).await
}
async fn safe_error(
    state: &State,
    grant: &WorkspaceAccess,
    body: &Value,
    error: ApiError,
) -> Result<ApiError> {
    if [400, 409, 413, 422].contains(&error.status.as_u16())
        && !state.is_closing()
        && blueprint::uuid(&body["requestId"]).is_ok()
    {
        let id = body["requestId"].as_str().unwrap();
        let mut tx = state
            .bot_templates
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await?;
        let exists =
            sqlx::query("SELECT 1 FROM template_mutations WHERE actor_id=? AND request_id=?")
                .bind(&grant.user_id)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
        grant.authorize_owner(state).await?;
        tx.rollback().await?;
        if !exists && !state.bot_templates.pending(&grant.user_id, id) {
            return Ok(error.with_code("BOT_TEMPLATE_NOT_APPLIED"));
        }
    }
    Ok(error)
}
pub async fn sync(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    only_fields(&body, &[])?;
    Ok(Json(projection::repair(&state, &grant, &id).await?))
}
pub async fn policy_get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let value = store::policy(
        &mut *state.bot_templates.pool.acquire().await?,
        &wid,
        &grant.kind,
    )
    .await?;
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
pub async fn policy_put(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    only_fields(&body, &["expectedRevision", "mode"])?;
    if !matches!(
        body["mode"].as_str(),
        Some("public" | "team-only" | "disabled")
    ) || body["mode"] == "team-only" && grant.kind != "team"
    {
        return Err(ApiError::bad("请选择有效的模板分享策略。"));
    }
    let _operation = state.bot_templates.operations.lock().await;
    let mut tx = state
        .bot_templates
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await?;
    let previous = store::policy(&mut tx, &wid, &grant.kind).await?;
    if previous["revision"] != body["expectedRevision"] {
        return Err(ApiError::new(409, "分享策略已更新，请重新载入。")
            .with_code("BOT_TEMPLATE_POLICY_CONFLICT"));
    }
    let value = json!({"revision":uuid::Uuid::new_v4().to_string(),"mode":body["mode"]});
    sqlx::query("INSERT INTO sharing_policies(workspace_id,data) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET data=excluded.data").bind(&wid).bind(value.to_string()).execute(&mut *tx).await?;
    let ids = sqlx::query_scalar::<_, String>("SELECT id FROM templates WHERE workspace_id=?")
        .bind(&wid)
        .fetch_all(&mut *tx)
        .await?;
    let mut changed = Vec::new();
    for id in ids {
        let mut template = store::read(&mut tx, &wid, &id).await?;
        if template.row.get("publication").is_some()
            && (value["mode"] == "disabled"
                || value["mode"] == "team-only"
                    && template.row["publication"]["audience"] == "public")
        {
            mutations::revoke(&mut tx, &mut template.row).await?;
            store::touch(&mut template.row);
            store::save(&mut tx, &template).await?;
            changed.push(id);
        }
    }
    grant.authorize_owner(&state).await?;
    tx.commit().await?;
    drop(_operation);
    for id in changed {
        projection::repair(&state, &grant, &id).await?;
    }
    grant.authorize_owner(&state).await?;
    Ok(Json(value))
}
