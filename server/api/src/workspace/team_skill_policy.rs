use super::{WorkspaceAccess, team_skill_publication, team_skills};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
};
use axum::{
    Json, Router,
    extract::{Path, State as Extract},
    http::HeaderMap,
    routing::get,
};
use serde::Serialize;
use sqlx::{Sqlite, SqliteConnection, Transaction};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Policy {
    pub member_publishing: bool,
    pub revision: String,
}

pub(super) fn router() -> Router<State> {
    Router::new().route(
        "/api/workspaces/{wid}/team-skills/publishing-policy",
        get(show).put(update),
    )
}

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS team_skill_publishing_policy (
        id INTEGER PRIMARY KEY CHECK(id=1), member_publishing INTEGER NOT NULL CHECK(member_publishing IN (0,1)), revision TEXT NOT NULL)")
        .execute(conn).await?;
    Ok(())
}

pub(super) async fn read(conn: &mut SqliteConnection) -> Result<Policy> {
    let row: Option<(bool, String)> = sqlx::query_as(
        "SELECT member_publishing,revision FROM team_skill_publishing_policy WHERE id=1",
    )
    .fetch_optional(conn)
    .await?;
    let (member_publishing, revision) = row.unwrap_or_else(|| (false, "unset".into()));
    Ok(Policy {
        member_publishing,
        revision,
    })
}

pub(super) fn check(policy: &Policy, owner: bool, expected: Option<&str>) -> Result<()> {
    if !owner && !policy.member_publishing {
        return Err(ApiError::new(403, "团队未开放成员发布技能。")
            .with_code("TEAM_SKILL_MEMBER_PUBLISHING_DISABLED"));
    }
    if expected != (!owner).then_some(policy.revision.as_str()) {
        return Err(changed());
    }
    Ok(())
}

fn changed() -> ApiError {
    ApiError::new(409, "团队技能发布权限已变化，请刷新后重试。")
        .with_code("TEAM_SKILL_POLICY_CHANGED")
}

pub(super) fn canonical_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
}

pub(super) async fn identity_fence(
    state: &State,
    grant: &WorkspaceAccess,
) -> Result<(Transaction<'static, Sqlite>, bool)> {
    let mut identity = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let owner = grant.owner_in(&mut identity).await?;
    if state.is_closing() {
        return Err(ApiError::new(503, "服务正在停止。"));
    }
    Ok((identity, owner))
}

async fn show(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Policy>> {
    let grant = team_skills::require(&state, &headers, &wid, true).await?;
    let store = grant.store(&state).await?;
    let policy = read(&mut *store.pool.acquire().await?).await?;
    grant.authorize(&state).await?;
    Ok(Json(policy))
}

async fn update(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Policy>> {
    only_fields(&body, &["memberPublishing", "expectedRevision"])?;
    let bad = || ApiError::bad("团队技能发布权限设置无效。");
    let member_publishing = body["memberPublishing"].as_bool().ok_or_else(bad)?;
    let expected = body["expectedRevision"]
        .as_str()
        .filter(|id| *id == "unset" || canonical_id(id))
        .ok_or_else(bad)?;
    let grant = team_skills::require(&state, &headers, &wid, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    let (identity, _) = identity_fence(&state, &grant).await?;
    let previous = read(&mut tx).await?;
    if expected != previous.revision {
        return Err(changed());
    }
    if previous.member_publishing == member_publishing {
        return Ok(Json(previous));
    }
    let revision = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO team_skill_publishing_policy VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET member_publishing=excluded.member_publishing,revision=excluded.revision")
        .bind(member_publishing).bind(&revision).execute(&mut *tx).await?;
    team_skill_publication::commit(tx, None, identity, Some(store)).await?;
    Ok(Json(Policy {
        member_publishing,
        revision,
    }))
}
