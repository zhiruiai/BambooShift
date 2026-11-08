use super::{
    Table, WorkspaceAccess, WorkspaceStore, access, knowledge, mutations, team_skill_catalog,
    team_skill_policy,
};
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

const PUBLICATION_LIMIT: i64 = 80;

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/workspaces/{wid}/team-skills", get(list).post(publish))
        .route(
            "/api/workspaces/{wid}/team-skills/import-targets",
            get(import_targets),
        )
        .route(
            "/api/workspaces/{wid}/team-skills/{id}/import",
            post(import),
        )
}

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS team_skill_publications (
            id TEXT PRIMARY KEY, source_agent TEXT NOT NULL, name TEXT NOT NULL,
            data TEXT NOT NULL, UNIQUE(source_agent,name))",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS team_skill_imports (
            revision TEXT NOT NULL, target_agent TEXT NOT NULL, skill_id TEXT NOT NULL,
            PRIMARY KEY(revision,target_agent))",
    )
    .execute(&mut *conn)
    .await?;
    super::team_skill_publication::initialize(conn).await?;
    team_skill_policy::initialize(conn).await?;
    team_skill_catalog::initialize(conn).await?;
    Ok(())
}

pub(super) async fn require(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
    owner: bool,
) -> Result<WorkspaceAccess> {
    let grant = access::require(state, headers, wid, owner, true).await?;
    if grant.kind != "team" {
        return Err(
            ApiError::new(403, "请在团队空间打开技能目录。").with_code("TEAM_SKILL_TEAM_REQUIRED")
        );
    }
    Ok(grant)
}

pub(super) fn uuid(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| ApiError::bad("技能目录标识无效。"))
}

pub(super) fn decode(raw: String) -> Result<Value> {
    serde_json::from_str(&raw).map_err(|_| ApiError::new(409, "技能目录记录不可用。"))
}

pub(super) fn conflict() -> ApiError {
    ApiError::new(409, "团队技能版本已变化，请刷新后重试。").with_code("TEAM_SKILL_REVISION")
}

async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<Value>>> {
    let grant = require(&state, &headers, &wid, false).await?;
    let store = grant.store(&state).await?;
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT p.data,a.user_id FROM team_skill_publications p
         LEFT JOIN team_skill_publishers a ON a.publication_id=p.id
         WHERE json_extract(p.data,'$.withdrawnAt') IS NULL
         ORDER BY json_extract(p.data,'$.updatedAt') DESC, p.id",
    )
    .fetch_all(&store.pool)
    .await?;
    let owner = grant.owner_in(&mut *state.pool.acquire().await?).await?;
    let values = rows
        .into_iter()
        .map(|(raw, publisher)| {
            Ok(team_skill_catalog::project(
                decode(raw)?,
                owner,
                publisher.as_deref(),
                &grant.user_id,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(values))
}

async fn personal_destination(
    state: &State,
    headers: &HeaderMap,
    workspace_id: &str,
) -> Result<WorkspaceAccess> {
    let grant = access::require(state, headers, workspace_id, true, true).await?;
    if grant.kind != "personal" {
        return Err(
            ApiError::new(403, "请选择你拥有的个人空间。").with_code("TEAM_SKILL_PERSONAL_TARGET")
        );
    }
    Ok(grant)
}

async fn import_targets(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<Value>>> {
    let source = require(&state, &headers, &wid, false).await?;
    let workspaces: Vec<(String, String)> = sqlx::query_as(
        "SELECT w.id,w.name FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
         WHERE m.user_id=? AND m.role='owner' AND w.kind='personal' AND w.status='active'
         ORDER BY w.created_at,w.id",
    )
    .bind(&source.user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut targets = Vec::new();
    for (id, name) in workspaces {
        let grant = personal_destination(&state, &headers, &id).await?;
        let bots: Vec<Value> = grant
            .store(&state)
            .await?
            .list(Table::Agents)
            .await?
            .into_iter()
            .filter(|agent| mutations::local(agent).is_ok())
            .map(|agent| json!({"id":agent["id"],"name":agent["name"]}))
            .collect();
        grant.authorize(&state).await?;
        targets.push(json!({"workspaceId":id,"workspaceName":name,"agents":bots}));
    }
    source.authorize(&state).await?;
    Ok(Json(targets))
}

async fn publish(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &["skillId", "expectedRevision"])?;
    let expected = body
        .get("expectedRevision")
        .ok_or_else(|| ApiError::bad("请确认团队技能版本。"))?;
    if !expected.is_null() {
        uuid(expected)?;
    }
    let grant = require(&state, &headers, &wid, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let skill_id = crate::error::text(&body["skillId"], "技能标识", 128)?;
    let skill = mutations::find(&mut tx, Table::Skills, &skill_id).await?;
    let source_id = skill["agentId"].as_str().unwrap_or("");
    let agent = mutations::find(&mut tx, Table::Agents, source_id).await?;
    mutations::local(&agent)?;
    if skill["status"] != "active"
        || skill.get("teamSource").is_some()
        || skill.get("privateSource").is_some()
    {
        return Err(ApiError::new(409, "请选择已启用且可发布的本地技能。")
            .with_code("TEAM_SKILL_SOURCE_REQUIRED"));
    }
    require_native_skill(&mut tx, &skill_id).await?;
    let name = crate::error::text(&skill["name"], "技能名称", 100)?;
    let description = crate::error::text(&skill["description"], "技能说明", 1000)?;
    let content = crate::error::text(&skill["content"], "技能内容", 16000)?;
    let previous = previous(&mut tx, source_id, &name).await?;
    let active = previous.as_ref().filter(|p| p["withdrawnAt"].is_null());
    if let Some(value) = active.filter(|p| p["source"]["skillId"] == skill["id"]) {
        grant.authorize(&state).await?;
        tx.commit().await?;
        return Ok(Json(team_skill_catalog::project(
            value.clone(),
            true,
            None,
            &grant.user_id,
        )));
    }
    if expected != active.map(|p| &p["revision"]).unwrap_or(&Value::Null) {
        return Err(conflict());
    }
    let draft = PublicationDraft {
        source_key: source_id,
        name: &name,
        description: &description,
        content: &content,
        source: json!({"agentId":source_id,"agentName":agent["name"],
            "skillId":skill["id"],"version":skill["version"]}),
    };
    let value = persist(&mut tx, draft, previous.as_ref()).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(Json(team_skill_catalog::project(
        value,
        true,
        None,
        &grant.user_id,
    )))
}

pub(super) async fn require_native_skill(conn: &mut SqliteConnection, skill: &str) -> Result<()> {
    let installed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM bot_install_receipts r, json_each(r.data,'$.skillIds') s WHERE s.value=?)",
    )
    .bind(skill)
    .fetch_one(conn)
    .await?;
    if installed {
        return Err(ApiError::new(409, "不能发布随 Bot 模板安装或复制的技能。")
            .with_code("TEAM_SKILL_TEMPLATE_SOURCE"));
    }
    Ok(())
}

pub(super) async fn previous(
    conn: &mut SqliteConnection,
    source: &str,
    name: &str,
) -> Result<Option<Value>> {
    sqlx::query_scalar::<_, String>(
        "SELECT data FROM team_skill_publications WHERE source_agent=? AND name=?",
    )
    .bind(source)
    .bind(name)
    .fetch_optional(conn)
    .await?
    .map(decode)
    .transpose()
}

pub(super) struct PublicationDraft<'a> {
    pub source_key: &'a str,
    pub name: &'a str,
    pub description: &'a str,
    pub content: &'a str,
    pub source: Value,
}

pub(super) async fn persist(
    conn: &mut SqliteConnection,
    draft: PublicationDraft<'_>,
    previous: Option<&Value>,
) -> Result<Value> {
    if previous.is_none_or(|p| !p["withdrawnAt"].is_null())
        && sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM team_skill_publications WHERE json_extract(data,'$.withdrawnAt') IS NULL",
        )
            .fetch_one(&mut *conn)
            .await?
            >= PUBLICATION_LIMIT
    {
        return Err(ApiError::new(409, "此团队已达到技能发布条目上限。")
            .with_code("TEAM_SKILL_CAPACITY"));
    }
    let id = previous
        .and_then(|p| p["id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let version = previous.and_then(|p| p["version"].as_u64()).unwrap_or(0) + 1;
    let link = previous
        .filter(|p| p["withdrawnAt"].is_null())
        .and_then(|p| p["linkId"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let value = json!({
        "id": id, "revision": uuid::Uuid::new_v4().to_string(), "version": version,
        "name": draft.name, "description": draft.description, "content": draft.content,
        "updatedAt": iso(now()), "source": draft.source, "linkId":link
    });
    sqlx::query(
        "INSERT INTO team_skill_publications(id,source_agent,name,data) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    )
    .bind(&id)
    .bind(draft.source_key)
    .bind(draft.name)
    .bind(value.to_string())
    .execute(conn)
    .await?;
    Ok(value)
}

pub(super) async fn publication(conn: &mut SqliteConnection, id: &str) -> Result<Value> {
    uuid(&json!(id))?;
    let raw =
        sqlx::query_scalar::<_, String>("SELECT data FROM team_skill_publications WHERE id=?")
            .bind(id)
            .fetch_optional(conn)
            .await?;
    decode(raw.ok_or_else(|| ApiError::new(404, "团队技能不可用。"))?)
}

async fn import(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    only_fields(&body, &["expectedRevision", "agentId", "targetWorkspaceId"])?;
    let revision = uuid(&body["expectedRevision"])?;
    let target = crate::error::text(&body["agentId"], "Bot 标识", 128)?;
    if let Some(workspace_id) = body.get("targetWorkspaceId") {
        let workspace_id = uuid(workspace_id)?;
        let source = require(&state, &headers, &wid, false).await?;
        let destination = personal_destination(&state, &headers, workspace_id).await?;
        let source_store = source.store(&state).await?;
        let target_store = destination.store(&state).await?;
        // Cross-workspace skill operations lock the team before the personal workspace.
        let mut source_tx = source_store.begin().await?;
        let mut target_tx = target_store.begin().await?;
        let (skill, created) =
            match existing_import(&mut target_tx, &id, &target, revision, Some(&wid)).await? {
                Some(skill) => (skill, false),
                None => {
                    let value = publication(&mut source_tx, &id).await?;
                    (
                        stage_import(&mut target_tx, &value, &id, &target, revision, Some(&wid))
                            .await?,
                        true,
                    )
                }
            };
        source.authorize(&state).await?;
        destination.authorize(&state).await?;
        target_tx.commit().await?;
        drop(source_tx);
        if created {
            target_store.emit("update", json!({}));
        }
        return Ok(Json(skill));
    }
    let grant = require(&state, &headers, &wid, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let (skill, created) = match existing_import(&mut tx, &id, &target, revision, None).await? {
        Some(skill) => (skill, false),
        None => {
            let value = publication(&mut tx, &id).await?;
            (
                stage_import(&mut tx, &value, &id, &target, revision, None).await?,
                true,
            )
        }
    };
    grant.authorize(&state).await?;
    tx.commit().await?;
    if created {
        store.emit("update", json!({}));
    }
    Ok(Json(skill))
}

async fn existing_import(
    conn: &mut SqliteConnection,
    id: &str,
    target: &str,
    revision: &str,
    source_workspace: Option<&str>,
) -> Result<Option<Value>> {
    let agent = mutations::find(conn, Table::Agents, target).await?;
    mutations::local(&agent)?;
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT skill_id FROM team_skill_imports WHERE revision=? AND target_agent=?",
    )
    .bind(revision)
    .bind(target)
    .fetch_optional(&mut *conn)
    .await?;
    let existing = match existing {
        Some(skill_id) => WorkspaceStore::get_in(conn, Table::Skills, &skill_id).await?,
        None => None,
    };
    if existing.as_ref().is_some_and(|skill| {
        let source = &skill["teamSource"];
        skill["agentId"] != target
            || source["id"] != id
            || source["revision"] != revision
            || source["workspaceId"].as_str() != source_workspace
    }) {
        return Err(conflict());
    }
    Ok(existing)
}

async fn stage_import(
    conn: &mut SqliteConnection,
    value: &Value,
    id: &str,
    target: &str,
    revision: &str,
    source_workspace: Option<&str>,
) -> Result<Value> {
    if value["revision"] != revision || !value["withdrawnAt"].is_null() {
        return Err(conflict());
    }
    if value["source"]["agentId"] == target {
        return Err(ApiError::bad("请选择另一个目标 Bot。"));
    }
    let mut source = json!({"id":id,"revision":revision,"version":value["version"]});
    if let Some(workspace_id) = source_workspace {
        source["workspaceId"] = json!(workspace_id);
    }
    let skill = knowledge::stage_skill(
        conn,
        &json!({"agentId":target,"name":value["name"],"description":value["description"],"content":value["content"]}),
        Some(source),
    )
    .await?;
    sqlx::query(
        "INSERT INTO team_skill_imports(revision,target_agent,skill_id) VALUES(?,?,?)
         ON CONFLICT(revision,target_agent) DO UPDATE SET skill_id=excluded.skill_id",
    )
    .bind(revision)
    .bind(target)
    .bind(skill["id"].as_str())
    .execute(conn)
    .await?;
    Ok(skill)
}
