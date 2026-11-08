use super::{team_skill_policy, team_skill_publication, team_skills};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result, only_fields},
};
use axum::{
    Json, Router,
    extract::{Path, State as Extract},
    http::HeaderMap,
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(super) fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/workspaces/{wid}/team-skills/{id}/unpublish",
            post(unpublish),
        )
        .route(
            "/api/workspaces/{wid}/team-skills/{id}/link/{link}",
            get(detail),
        )
}

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS team_skill_publishers (
        publication_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, moderated_at TEXT)",
    )
    .execute(&mut *conn)
    .await?;
    let legacy: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM team_skill_publications WHERE json_extract(data,'$.withdrawnAt') IS NULL
          AND json_extract(data,'$.linkId') IS NULL",
    )
    .fetch_all(&mut *conn)
    .await?;
    for id in legacy {
        sqlx::query(
            "UPDATE team_skill_publications SET data=json_set(data,'$.linkId',?) WHERE id=?",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

fn can_withdraw(owner: bool, publisher: Option<&str>, user: &str) -> bool {
    owner || publisher == Some(user)
}

fn can_moderate(owner: bool, publisher: Option<&str>, user: &str) -> bool {
    owner && publisher.is_some_and(|publisher| publisher != user)
}

pub(super) fn project(mut value: Value, owner: bool, publisher: Option<&str>, user: &str) -> Value {
    value["canWithdraw"] = json!(can_withdraw(owner, publisher, user));
    value["canModerate"] = json!(can_moderate(owner, publisher, user));
    value
}

pub(super) async fn may_publish(
    conn: &mut SqliteConnection,
    id: &str,
    user: &str,
    owner: bool,
) -> Result<()> {
    let entry: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT user_id,moderated_at FROM team_skill_publishers WHERE publication_id=?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    if entry
        .as_ref()
        .is_some_and(|(publisher, _)| publisher != user)
        || (entry.is_none() && !owner)
    {
        return Err(ApiError::new(403, "只有原发布者可以同步此团队技能。")
            .with_code("TEAM_SKILL_PUBLISHER_MISMATCH"));
    }
    if entry.is_some_and(|(_, moderated)| moderated.is_some()) {
        return Err(
            ApiError::new(409, "团队所有者已撤除此发布。").with_code("TEAM_SKILL_MODERATED")
        );
    }
    Ok(())
}

pub(super) async fn remember_publisher(
    conn: &mut SqliteConnection,
    id: &str,
    user: &str,
) -> Result<bool> {
    let result = sqlx::query("INSERT OR IGNORE INTO team_skill_publishers VALUES(?,?,NULL)")
        .bind(id)
        .bind(user)
        .execute(conn)
        .await?;
    Ok(result.rows_affected() != 0)
}

async fn detail(
    Extract(state): Extract<State>,
    Path((wid, id, link)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = team_skills::require(&state, &headers, &wid, false).await?;
    let unavailable =
        || ApiError::new(404, "此团队技能链接不可用。").with_code("TEAM_SKILL_LINK_UNAVAILABLE");
    if ![wid.as_str(), id.as_str(), link.as_str()]
        .into_iter()
        .all(team_skill_policy::canonical_id)
    {
        return Err(unavailable());
    }
    let store = grant.store(&state).await?;
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT p.data,a.user_id FROM team_skill_publications p
         LEFT JOIN team_skill_publishers a ON a.publication_id=p.id
         WHERE p.id=? AND json_extract(p.data,'$.linkId')=? AND json_extract(p.data,'$.withdrawnAt') IS NULL",
    )
    .bind(id)
    .bind(link)
    .fetch_optional(&store.pool)
    .await?;
    let owner = grant.owner_in(&mut *state.pool.acquire().await?).await?;
    let (raw, publisher) = row.ok_or_else(unavailable)?;
    Ok(Json(project(
        team_skills::decode(raw)?,
        owner,
        publisher.as_deref(),
        &grant.user_id,
    )))
}

async fn unpublish(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &["expectedRevision"])?;
    let revision = team_skills::uuid(&body["expectedRevision"])?;
    let grant = team_skills::require(&state, &headers, &wid, false).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    let (identity, owner) = team_skill_policy::identity_fence(&state, &grant).await?;
    let publisher: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM team_skill_publishers WHERE publication_id=?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    if !can_withdraw(owner, publisher.as_deref(), &grant.user_id) {
        return Err(ApiError::new(403, "只有发布者或团队所有者可以撤回此技能。")
            .with_code("TEAM_SKILL_PUBLISHER_MISMATCH"));
    }
    let value = team_skills::publication(&mut tx, &id).await?;
    if value["revision"] != revision {
        return Err(team_skills::conflict());
    }
    let timestamp = iso(now());
    let withdrew = value["withdrawnAt"].is_null();
    if withdrew {
        sqlx::query("UPDATE team_skill_publications SET data=json_remove(json_set(data,'$.withdrawnAt',?),'$.linkId') WHERE id=?")
            .bind(&timestamp).bind(&id).execute(&mut *tx).await?;
    }
    let moderated = if can_moderate(owner, publisher.as_deref(), &grant.user_id) {
        sqlx::query("UPDATE team_skill_publishers SET moderated_at=? WHERE publication_id=? AND moderated_at IS NULL")
            .bind(&timestamp)
            .bind(&id)
            .execute(&mut *tx)
            .await?.rows_affected() > 0
    } else {
        false
    };
    if withdrew || moderated {
        team_skill_publication::commit(tx, None, identity, Some(store)).await?;
    }
    Ok(Json(json!({"ok":true})))
}
