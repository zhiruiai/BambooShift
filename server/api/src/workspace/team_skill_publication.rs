use super::{
    WorkspaceAccess, WorkspaceStore, private_skills, team_skill_catalog, team_skill_policy,
    team_skills,
};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
};
use axum::{
    Json, Router,
    extract::{Path, State as Extract},
    http::HeaderMap,
    routing::{get, put},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqliteConnection, Transaction};
use std::sync::Arc;

pub(super) fn router() -> Router<State> {
    Router::new()
        .route(
            "/api/workspaces/{wid}/private-skills/{skill}/team-publication-targets",
            get(targets),
        )
        .route(
            "/api/workspaces/{wid}/private-skills/{skill}/team-publications/{team}",
            put(publish),
        )
        .route(
            "/api/workspaces/{wid}/private-skills/{skill}/team-publications/{team}/{request}",
            get(get_receipt).delete(cancel),
        )
}

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    for query in [
        "CREATE TABLE IF NOT EXISTS team_skill_personal_sources (
            publication_id TEXT PRIMARY KEY, source_revision TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS team_skill_publication_requests (
            request_id TEXT PRIMARY KEY, scope_digest TEXT NOT NULL,
            input_digest TEXT, response TEXT NOT NULL)",
    ] {
        sqlx::query(query).execute(&mut *conn).await?;
    }
    Ok(())
}

fn hash(value: Value) -> String {
    hex::encode(Sha256::digest(value.to_string()))
}

fn bad() -> ApiError {
    ApiError::bad("团队技能发布请求无效。")
}

fn changed() -> ApiError {
    ApiError::new(409, "原私有技能已变化、不可用或缺少说明，请重新核对。")
        .with_code("TEAM_SKILL_SOURCE_CHANGED")
}

fn request_conflict() -> ApiError {
    ApiError::new(409, "此发布请求已经用于其他内容，请重新核对。")
        .with_code("TEAM_SKILL_REQUEST_CONFLICT")
}

fn not_found() -> ApiError {
    ApiError::new(404, "未找到这次团队技能发布请求。").with_code("TEAM_SKILL_PUBLICATION_NOT_FOUND")
}

fn closed() -> ApiError {
    ApiError::new(409, "这次团队技能发布请求已取消。").with_code("TEAM_SKILL_REQUEST_CLOSED")
}

fn uuid(value: &str) -> Result<&str> {
    team_skill_policy::canonical_id(value)
        .then_some(value)
        .ok_or_else(bad)
}

fn valid_skill(skill: &str) -> Result<()> {
    if skill.is_empty() || skill.len() > 128 || skill.chars().any(char::is_control) {
        return Err(bad());
    }
    Ok(())
}

struct Request<'a> {
    id: &'a str,
    source: &'a str,
    publication: Option<&'a str>,
    policy: Option<&'a str>,
}

impl<'a> Request<'a> {
    fn read(body: &'a Value) -> Result<Self> {
        only_fields(
            body,
            &[
                "requestId",
                "expectedSourceRevision",
                "expectedPublicationRevision",
                "expectedTeamPolicyRevision",
            ],
        )?;
        let id = uuid(body["requestId"].as_str().ok_or_else(bad)?)?;
        let source = body["expectedSourceRevision"]
            .as_str()
            .filter(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            .ok_or_else(bad)?;
        let publication = match body.get("expectedPublicationRevision") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(uuid(value)?),
            _ => return Err(bad()),
        };
        let policy = match body.get("expectedTeamPolicyRevision") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(uuid(value)?),
            _ => return Err(bad()),
        };
        Ok(Self {
            id,
            source,
            publication,
            policy,
        })
    }

    fn digest(&self) -> String {
        match self.policy {
            Some(policy) => hash(json!([self.source, self.publication, policy])),
            None => hash(json!([self.source, self.publication])),
        }
    }
}

struct Scope {
    personal: WorkspaceAccess,
    team: WorkspaceAccess,
    digest: String,
}

impl Scope {
    async fn require(
        state: &State,
        headers: &HeaderMap,
        wid: &str,
        skill: &str,
        team: &str,
    ) -> Result<Self> {
        valid_skill(skill)?;
        let personal = private_skills::require(state, headers, wid).await?;
        let team = team_skills::require(state, headers, team, false).await?;
        if personal.user_id != team.user_id || personal.session_id != team.session_id {
            return Err(ApiError::new(403, "请确认当前账户后重试。"));
        }
        let digest = hash(json!([
            personal.user_id,
            personal.workspace_id,
            skill,
            team.workspace_id
        ]));
        Ok(Self {
            personal,
            team,
            digest,
        })
    }

    async fn fence(&self, state: &State) -> Result<(Transaction<'static, Sqlite>, bool)> {
        let (mut identity, owner) = team_skill_policy::identity_fence(state, &self.team).await?;
        self.personal.authorize_in(&mut identity).await?;
        Ok((identity, owner))
    }
}

pub(super) async fn commit(
    team: Transaction<'static, Sqlite>,
    personal: Option<Transaction<'static, Sqlite>>,
    identity: Transaction<'static, Sqlite>,
    update: Option<Arc<WorkspaceStore>>,
) -> Result<()> {
    // Keep both leases until SQLite confirms the commit, even if the HTTP caller leaves.
    tokio::spawn(async move {
        team.commit().await?;
        drop(identity);
        drop(personal);
        if let Some(store) = update {
            store.emit("update", json!({}));
        }
        Ok(())
    })
    .await
    .map_err(|_| ApiError::new(503, "发布结果暂时无法确认，请查阅原请求。"))?
}

fn source_key(personal: &WorkspaceAccess, review: &private_skills::Entry) -> String {
    format!(
        "personal:{}",
        hash(json!([personal.workspace_id, review.source_agent_id]))
    )
}

async fn review(conn: &mut SqliteConnection, skill: &str) -> Result<private_skills::Entry> {
    team_skills::require_native_skill(conn, skill).await?;
    private_skills::review_in(conn, skill)
        .await?
        .filter(|entry| !entry.description.trim().is_empty())
        .ok_or_else(changed)
}

async fn summary(conn: &mut SqliteConnection, publication: &Value) -> Result<Value> {
    let revision: Option<String> = sqlx::query_scalar(
        "SELECT source_revision FROM team_skill_personal_sources WHERE publication_id=?",
    )
    .bind(publication["id"].as_str())
    .fetch_optional(conn)
    .await?;
    let revision = revision.ok_or_else(team_skills::conflict)?;
    let mut summary = json!({"id":publication["id"],"revision":publication["revision"],
        "version":publication["version"],"sourceRevision":revision});
    if let Some(link) = publication["linkId"].as_str() {
        summary["linkId"] = json!(link);
    }
    Ok(summary)
}

async fn targets(
    Extract(state): Extract<State>,
    Path((wid, skill)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    valid_skill(&skill)?;
    let personal = private_skills::require(&state, &headers, &wid).await?;
    let store = personal.store(&state).await?;
    let source = review(&mut *store.pool.acquire().await?, &skill).await?;
    let key = source_key(&personal, &source);
    let memberships: Vec<(String, String)> = sqlx::query_as(
        "SELECT w.id,w.name FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
         WHERE m.user_id=? AND w.kind='team' AND w.status='active'
         ORDER BY w.created_at,w.id",
    )
    .bind(&personal.user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut teams = Vec::new();
    for (id, name) in memberships {
        let team = match team_skills::require(&state, &headers, &id, false).await {
            Ok(team) => team,
            Err(error) if error.status.as_u16() == 403 => continue,
            Err(error) => return Err(error),
        };
        let store = team.store(&state).await?;
        let mut tx = store.pool.begin().await?;
        let policy = team_skill_policy::read(&mut tx).await?;
        let owner = team.owner_in(&mut *state.pool.acquire().await?).await?;
        if !owner && !policy.member_publishing {
            continue;
        }
        let existing = team_skills::previous(&mut tx, &key, &source.name).await?;
        if let Some(id) = existing.as_ref().and_then(|item| item["id"].as_str()) {
            match team_skill_catalog::may_publish(&mut tx, id, &team.user_id, owner).await {
                Ok(()) => {}
                Err(error) if error.status.as_u16() == 403 || error.status.as_u16() == 409 => {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        let publication = if let Some(active) = existing.filter(|p| p["withdrawnAt"].is_null()) {
            summary(&mut tx, &active).await?
        } else {
            Value::Null
        };
        team.authorize(&state).await?;
        teams.push(
            json!({"workspaceId":id,"workspaceName":name,"publication":publication,
            "policyRevision":(!owner).then_some(policy.revision)}),
        );
    }
    personal.authorize(&state).await?;
    Ok(Json(json!({"teams":teams})))
}

struct Receipt {
    scope: String,
    input: Option<String>,
    response: Value,
}

async fn receipt(conn: &mut SqliteConnection, id: &str) -> Result<Option<Receipt>> {
    let row: Option<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT scope_digest,input_digest,response FROM team_skill_publication_requests WHERE request_id=?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    row.map(|(scope, input, response)| {
        let response = serde_json::from_str(&response).map_err(|_| request_conflict())?;
        Ok(Receipt {
            scope,
            input,
            response,
        })
    })
    .transpose()
}

async fn save_receipt(
    conn: &mut SqliteConnection,
    id: &str,
    scope: &Scope,
    input: Option<&str>,
    response: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO team_skill_publication_requests VALUES(?,?,?,?)")
        .bind(id)
        .bind(&scope.digest)
        .bind(input)
        .bind(response.to_string())
        .execute(conn)
        .await?;
    Ok(())
}

async fn publish(
    Extract(state): Extract<State>,
    Path((wid, skill, team)): Path<(String, String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let request = Request::read(&body)?;
    let scope = Scope::require(&state, &headers, &wid, &skill, &team).await?;
    let target = scope.team.store(&state).await?;
    let source = scope.personal.store(&state).await?;
    let mut target_tx = target.pool.begin_with("BEGIN IMMEDIATE").await?;
    let digest = request.digest();
    if let Some(saved) = receipt(&mut target_tx, request.id).await? {
        if saved.scope != scope.digest {
            return Err(request_conflict());
        }
        let previous = saved.input.as_deref().ok_or_else(closed)?;
        if previous != digest {
            return Err(request_conflict());
        }
        scope.personal.authorize(&state).await?;
        scope.team.authorize(&state).await?;
        return Ok(Json(saved.response));
    }

    // Imports and publications both acquire the team lock before the personal lock.
    let mut source_tx = source.pool.begin_with("BEGIN IMMEDIATE").await?;
    let (identity, owner) = scope.fence(&state).await?;
    let policy = team_skill_policy::read(&mut target_tx).await?;
    team_skill_policy::check(&policy, owner, request.policy)?;
    let reviewed = review(&mut source_tx, &skill).await?;
    if reviewed.revision != request.source {
        return Err(changed());
    }
    let (value, modified) = stage(
        &mut target_tx,
        &scope,
        &reviewed,
        request.publication,
        owner,
    )
    .await?;
    let response = json!({"publication":value});
    save_receipt(&mut target_tx, request.id, &scope, Some(&digest), &response).await?;
    commit(
        target_tx,
        Some(source_tx),
        identity,
        modified.then_some(target),
    )
    .await?;
    Ok(Json(response))
}

async fn stage(
    conn: &mut SqliteConnection,
    scope: &Scope,
    review: &private_skills::Entry,
    expected: Option<&str>,
    owner: bool,
) -> Result<(Value, bool)> {
    let key = source_key(&scope.personal, review);
    let previous = team_skills::previous(conn, &key, &review.name).await?;
    if let Some(id) = previous.as_ref().and_then(|item| item["id"].as_str()) {
        team_skill_catalog::may_publish(conn, id, &scope.personal.user_id, owner).await?;
    }
    let active = previous.as_ref().filter(|p| p["withdrawnAt"].is_null());
    if active.and_then(|p| p["revision"].as_str()) != expected {
        return Err(team_skills::conflict());
    }
    if let Some(active) = active {
        let summary = summary(conn, active).await?;
        if summary["sourceRevision"] == review.revision {
            let changed = team_skill_catalog::remember_publisher(
                conn,
                active["id"].as_str().ok_or_else(team_skills::conflict)?,
                &scope.personal.user_id,
            )
            .await?;
            return Ok((summary, changed));
        }
    }
    let draft = team_skills::PublicationDraft {
        source_key: &key,
        name: &review.name,
        description: &review.description,
        content: &review.content,
        source: json!({"origin":"personal","version":review.version}),
    };
    let value = team_skills::persist(conn, draft, previous.as_ref()).await?;
    let id = value["id"].as_str().ok_or_else(team_skills::conflict)?;
    team_skill_catalog::remember_publisher(conn, id, &scope.personal.user_id).await?;
    sqlx::query(
        "INSERT INTO team_skill_personal_sources VALUES(?,?)
        ON CONFLICT(publication_id) DO UPDATE SET source_revision=excluded.source_revision",
    )
    .bind(id)
    .bind(&review.revision)
    .execute(&mut *conn)
    .await?;
    Ok((summary(conn, &value).await?, true))
}

async fn get_receipt(
    Extract(state): Extract<State>,
    Path((wid, skill, team, request)): Path<(String, String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    uuid(&request)?;
    let scope = Scope::require(&state, &headers, &wid, &skill, &team).await?;
    let store = scope.team.store(&state).await?;
    let saved = receipt(&mut *store.pool.acquire().await?, &request)
        .await?
        .filter(|saved| saved.scope == scope.digest)
        .ok_or_else(not_found)?;
    scope.personal.authorize(&state).await?;
    scope.team.authorize(&state).await?;
    Ok(Json(saved.response))
}

async fn cancel(
    Extract(state): Extract<State>,
    Path((wid, skill, team, request)): Path<(String, String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    uuid(&request)?;
    let scope = Scope::require(&state, &headers, &wid, &skill, &team).await?;
    let store = scope.team.store(&state).await?;
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(saved) = receipt(&mut tx, &request).await? {
        if saved.scope != scope.digest {
            return Err(request_conflict());
        }
        scope.personal.authorize(&state).await?;
        scope.team.authorize(&state).await?;
        return Ok(Json(saved.response));
    }
    let response = json!({"status":"cancelled"});
    save_receipt(&mut tx, &request, &scope, None, &response).await?;
    let (identity, _) = scope.fence(&state).await?;
    commit(tx, None, identity, None).await?;
    Ok(Json(response))
}

#[cfg(test)]
#[path = "team_skill_publication_tests.rs"]
mod tests;
