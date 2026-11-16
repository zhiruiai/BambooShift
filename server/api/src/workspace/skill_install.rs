use super::{Table, WorkspaceStore, access, knowledge, mutations, skill_packages::Package};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};

/// A human's installation decision includes the full reviewed package and the
/// current active version. Store resources and activate in the same transaction.
pub async fn install(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    only_fields(
        &body,
        &[
            "agentId",
            "name",
            "description",
            "content",
            "skillPackage",
            "expectedActiveId",
        ],
    )?;
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let expected = body
        .get("expectedActiveId")
        .filter(|value| {
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        })
        .ok_or_else(|| ApiError::bad("请重新查看当前技能版本后安装。"))?;
    let package = Package::parse(&body, &body["skillPackage"])?;
    let manifest = package.manifest();
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let agent = mutations::find(
        &mut tx,
        Table::Agents,
        body["agentId"].as_str().unwrap_or(""),
    )
    .await?;
    mutations::local(&agent)?;
    let all = WorkspaceStore::list_in(&mut tx, Table::Skills).await?;
    let same_lineage =
        |skill: &&Value| skill["agentId"] == body["agentId"] && skill["name"] == package.name;
    let exact = |skill: &Value| {
        skill["description"] == package.description
            && skill["content"] == package.content
            && skill["skillPackage"] == manifest
    };
    let active = all
        .iter()
        .filter(same_lineage)
        .find(|skill| skill["status"] == "active");
    // A lost response or a concurrent identical click must not create another
    // version. This exception never replaces a different active package.
    if let Some(active) = active.filter(|skill| exact(skill)) {
        grant.authorize(&state).await?;
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(active.clone())));
    }
    if expected
        != &active
            .map(|skill| skill["id"].clone())
            .unwrap_or(Value::Null)
    {
        return Err(ApiError::new(409, "当前技能版本已变化，请重新查看后安装。")
            .with_code("SKILL_INSTALL_CHANGED"));
    }
    let proposed = all
        .iter()
        .filter(same_lineage)
        .filter(|skill| skill["status"] == "proposed" && exact(skill))
        .max_by_key(|skill| skill["version"].as_u64().unwrap_or(0));
    let (mut skill, status) = if let Some(proposed) = proposed {
        (proposed.clone(), StatusCode::OK)
    } else {
        (
            knowledge::stage_skill(&mut tx, &body, None).await?,
            StatusCode::CREATED,
        )
    };
    knowledge::activate_skill(&mut tx, &mut skill, &all, true).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    state.workspace.emit_all("update", json!({})).await;
    Ok((status, Json(skill)))
}
