use super::{cloud::Cloud, controller, discovery, model};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
    workspace::access,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, header},
    response::IntoResponse,
};
use serde_json::{Value, json};

pub async fn check(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<impl IntoResponse> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    only_fields(&body, &["url", "token"])?;
    let token = body["token"].as_str().unwrap_or("");
    let url = model::worker_url(body["url"].as_str().unwrap_or(""))?;
    model::validate_token(token)?;
    let store = actor.store(&state).await?;
    let cloud = Cloud::open(&store.directory, &store.workspace_id);
    if let Some(guard) = cloud.guard(&url) {
        guard().await?;
    }
    let authorize = controller::user_authority(&state, &actor);
    // Do not open the controller or allocate a target revision for a proposed connection.
    let (_, health) = discovery::discover(
        &url,
        token,
        &wid,
        state.config.public_origin.as_deref(),
        None,
        None,
        &authorize,
    )
    .await?;
    if health.workspace_scope.as_deref() != Some(wid.as_str()) {
        return Err(
            ApiError::new(409, "工作电脑未绑定此工作空间。").with_code("WORKER_SCOPE_REQUIRED")
        );
    }
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(capabilities(&health)),
    ))
}

fn capabilities(health: &model::Health) -> Value {
    let pool = health.saved.has(model::SCREEN_POOL);
    let desktop = &health.state["desktop"];
    json!({
        "topology": if pool {
            "pool"
        } else if health.saved.has(model::SHARED_SCREEN) {
            "shared"
        } else {
            "legacy"
        },
        "browser": if pool {
            "perScreen"
        } else if health.saved.has("browser") {
            "supported"
        } else {
            "unavailable"
        },
        "desktop": if pool {
            "perScreen"
        } else if health.saved.has(model::HOST_DESKTOP) || desktop["kind"] == "virtual" {
            if desktop["available"] == true && desktop["authorized"] == true {
                "ready"
            } else {
                "notReady"
            }
        } else {
            "unavailable"
        },
    })
}
