use crate::{db::State, error::Result};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};

pub async fn status(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = super::access::require(&state, &headers, &wid, false, false).await?;
    grant.authorize(&state).await?;
    Ok(Json(
        json!({"mode":"account","paired":true,"publicOrigin":state.config.public_origin}),
    ))
}
