use super::{
    resources::request_uuid,
    source::{self, Source, SourceDatabase, Workspace},
    store::{Share, SharedBots, opaque, unavailable, uuid},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields},
    workspace::WorkspaceAccess,
};
use serde_json::{Value, json};
use sqlx::Row;

pub(crate) struct Definition {
    pub share: Share,
    pub source: Source,
    pub owner_name: String,
    pub workspace_name: String,
    pub team_name: String,
    pub apps_revision: String,
}
pub(crate) async fn source_owner(
    state: &State,
    grant: &WorkspaceAccess,
    agent: &str,
) -> Result<Workspace> {
    grant.authorize_owner(state).await?;
    let workspace = source::workspace(state, &grant.workspace_id).await?;
    let mut db = SourceDatabase::open(state, &workspace).await?;
    db.agent(agent).await?;
    Ok(workspace)
}
pub(crate) async fn authorize_share(
    state: &State,
    user: &str,
    share: &Share,
) -> Result<(Workspace, String, String)> {
    state.shared_bots.ensure_open()?;
    if share.status != "active"
        || (share.audience == "selected"
            && share.created_by != user
            && !share.member_ids.iter().any(|s| s == user))
    {
        return Err(unavailable());
    }
    let workspace = source::workspace(state, &share.source_workspace_id).await?;
    let team = source::workspace(state, &share.target_team_id).await?;
    if team.kind != "team" || (workspace.kind == "team" && workspace.id != team.id) {
        return Err(unavailable());
    }
    let owner = source::member(state, &share.created_by, &workspace.id, true).await?;
    source::member(state, &share.created_by, &team.id, false).await?;
    source::member(state, user, &team.id, false).await?;
    Ok((workspace, owner, team.name))
}
pub(crate) async fn definition(state: &State, user: &str, id: &str) -> Result<Definition> {
    let share = state.shared_bots.get(id).await?;
    let (workspace, owner_name, team_name) = authorize_share(state, user, &share).await?;
    let mut db = SourceDatabase::open(state, &workspace).await?;
    let source = db.read(&share.source_agent_id).await?;
    let apps_revision = super::source_apps::state_revision(
        state,
        &workspace,
        share.apps.as_deref().unwrap_or(&[]),
        &share.revision,
    )
    .await;
    authorize_share(state, user, &share).await?;
    let latest = state.shared_bots.get(id).await?;
    if latest.access_revision != share.access_revision {
        return Err(unavailable());
    }
    Ok(Definition {
        apps_revision,
        share,
        source,
        owner_name,
        team_name,
        workspace_name: workspace.name,
    })
}
pub(crate) fn metadata(d: &Definition) -> Value {
    let mut v = json!({"shareId":d.share.id,"sourceRevision":d.source.revision,"ownerName":d.owner_name,"sourceWorkspaceName":d.workspace_name,"teamName":d.team_name,"status":"active","fileCount":d.share.files.as_ref().map_or(0,Vec::len),"filesRevision":d.share.revision,"appCount":d.share.apps.as_ref().map_or(0,Vec::len),"appsRevision":d.apps_revision});
    if d.source.avatar.is_some() {
        v["avatarPath"] = json!(format!(
            "/api/shared-bots/{}/avatar?revision={}",
            d.share.id, d.source.revision
        ));
    }
    v
}
pub(crate) fn card(d: &Definition) -> Value {
    let mut v = d.source.profile.clone();
    v.as_object_mut().unwrap().remove("instructions");
    v["id"] = json!(d.share.id);
    v["ownerName"] = json!(d.owner_name);
    v["sourceWorkspaceName"] = json!(d.workspace_name);
    v["teamName"] = json!(d.team_name);
    v["targetTeamId"] = json!(d.share.target_team_id);
    v["sourceRevision"] = json!(d.source.revision);
    v["skillCount"] = json!(d.source.skills.len());
    v["fileCount"] = json!(d.share.files.as_ref().map_or(0, Vec::len));
    v["appCount"] = json!(d.share.apps.as_ref().map_or(0, Vec::len));
    v["appsRevision"] = json!(d.apps_revision);
    if let Some(path) = metadata(d).get("avatarPath") {
        v["avatarPath"] = path.clone();
    }
    v
}
pub async fn list_visible(state: &State, user: &str, team: Option<&str>) -> Result<Vec<Value>> {
    if team.is_some_and(|v| !uuid(v)) {
        return Err(ApiError::bad("团队标识无效。"));
    }
    state.shared_bots.ensure_open()?;
    if let Some(team) = team {
        source::member(state, user, team, false).await?;
        if source::workspace(state, team).await?.kind != "team" {
            return Err(unavailable());
        }
    }
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM shared_bots ORDER BY rowid DESC")
        .fetch_all(&state.shared_bots.pool)
        .await?;
    let mut result = Vec::new();
    for id in ids {
        if let Ok(d) = definition(state, user, &id).await {
            if team.is_none_or(|t| t == d.share.target_team_id) {
                result.push(card(&d));
            }
        }
    }
    Ok(result)
}
pub(crate) async fn team_options(state: &State, grant: &WorkspaceAccess) -> Result<Vec<Value>> {
    grant.authorize_owner(state).await?;
    let rows=sqlx::query("SELECT w.id,w.name FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.status='active' AND w.kind='team' AND m.user_id=? ORDER BY w.created_at,w.id").bind(&grant.user_id).fetch_all(&state.pool).await?;
    let mut result = Vec::new();
    for row in rows {
        let id: String = row.get("id");
        if grant.kind == "team" && id != grant.workspace_id {
            continue;
        }
        let members=sqlx::query("SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=? AND u.status='active' ORDER BY m.joined_at,u.id").bind(&id).fetch_all(&state.pool).await?;
        result.push(json!({"id":id,"name":row.get::<String,_>("name"),"members":members.iter().map(|r|json!({"userId":r.get::<String,_>("id"),"name":r.get::<String,_>("name")})).collect::<Vec<_>>()}));
    }
    grant.authorize_owner(state).await?;
    Ok(result)
}
pub(crate) async fn sharing(state: &State, grant: &WorkspaceAccess, agent: &str) -> Result<Value> {
    source_owner(state, grant, agent).await?;
    let share = SharedBots::source_in(
        &mut *state.shared_bots.pool.acquire().await?,
        &grant.workspace_id,
        agent,
    )
    .await?;
    let teams = team_options(state, grant).await?;
    Ok(json!({"share":share,"teams":teams}))
}
pub(crate) async fn mutate(
    state: &State,
    grant: &WorkspaceAccess,
    agent: &str,
    body: &Value,
    revoke: bool,
) -> Result<()> {
    state.shared_bots.ensure_open()?;
    grant.authorize_owner(state).await?;
    if !opaque(agent) {
        return Err(ApiError::bad("Bot标识无效。"));
    }
    only_fields(
        body,
        if revoke {
            &["requestId", "expectedRevision"]
        } else {
            &[
                "requestId",
                "expectedRevision",
                "targetTeamId",
                "audience",
                "memberIds",
                "files",
                "apps",
            ]
        },
    )?;
    let request = request_uuid(body, "requestId")?;
    let expected = body["expectedRevision"]
        .as_str()
        .filter(|v| *v == "unset" || uuid(v))
        .ok_or_else(|| ApiError::bad("共享版本无效。"))?;
    let digest = super::request::digest(&grant.workspace_id, agent, body, revoke)?;
    let mut tx = state.shared_bots.pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(row) = sqlx::query(
        "SELECT digest,share_id FROM shared_bot_mutations WHERE actor_id=? AND request_id=?",
    )
    .bind(&grant.user_id)
    .bind(&request)
    .fetch_optional(&mut *tx)
    .await?
    {
        if row.get::<String, _>("digest") != digest {
            return Err(ApiError::new(409, "此请求标识已用于另一项修改。"));
        }
        let prior = SharedBots::get_in(&mut tx, &row.get::<String, _>("share_id"))
            .await?
            .ok_or_else(unavailable)?;
        if prior.source_workspace_id != grant.workspace_id || prior.source_agent_id != agent {
            return Err(unavailable());
        }
        grant.authorize_owner(state).await?;
        tx.commit().await?;
        return Ok(());
    }
    let workspace = source_owner(state, grant, agent).await?;
    SourceDatabase::open(state, &workspace)
        .await?
        .read(agent)
        .await?;
    let old = SharedBots::source_in(&mut tx, &grant.workspace_id, agent).await?;
    if old.as_ref().map(|s| s.revision.as_str()).unwrap_or("unset") != expected {
        return Err(ApiError::new(409, "共享设置已变化，请重新载入。"));
    }
    let mut file_guards = Vec::new();
    let mut share = if revoke {
        old.clone()
            .ok_or_else(|| ApiError::new(409, "Bot尚未共享。"))?
    } else {
        let team_id = request_uuid(body, "targetTeamId")?;
        let audience = body["audience"]
            .as_str()
            .filter(|v| ["team", "selected"].contains(v))
            .ok_or_else(|| ApiError::bad("共享范围无效。"))?;
        let ids = body["memberIds"]
            .as_array()
            .filter(|v| v.len() <= 200)
            .ok_or_else(|| ApiError::bad("请选择团队成员。"))?;
        let mut member_ids = Vec::new();
        for value in ids {
            let id = value
                .as_str()
                .filter(|v| opaque(v))
                .ok_or_else(|| ApiError::bad("成员标识无效。"))?;
            if member_ids.contains(&id.to_owned()) {
                return Err(ApiError::bad("成员不能重复。"));
            }
            source::member(state, id, &team_id, false).await?;
            member_ids.push(id.to_owned());
        }
        if audience == "team" && !member_ids.is_empty() {
            return Err(ApiError::bad("全团队分享不接受指定成员。"));
        }
        member_ids.sort();
        if source::workspace(state, &team_id).await?.kind != "team"
            || (workspace.kind == "team" && workspace.id != team_id)
        {
            return Err(unavailable());
        }
        source::member(state, &grant.user_id, &team_id, false).await?;
        let (files, inspected) = super::files::select(
            state,
            &workspace,
            body.get("files"),
            old.as_ref().and_then(|s| s.files.as_ref()),
        )
        .await?;
        file_guards = inspected;
        let apps = super::source_apps::select(
            state,
            &workspace,
            body.get("apps"),
            old.as_ref().and_then(|s| s.apps.as_ref()),
        )
        .await?;
        Share {
            id: old
                .as_ref()
                .map(|s| s.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            source_workspace_id: grant.workspace_id.clone(),
            source_agent_id: agent.to_owned(),
            created_by: old
                .as_ref()
                .map(|s| s.created_by.clone())
                .unwrap_or_else(|| grant.user_id.clone()),
            target_team_id: team_id,
            audience: audience.to_owned(),
            member_ids,
            status: "active".into(),
            revision: String::new(),
            access_revision: String::new(),
            created_at: old
                .as_ref()
                .map(|s| s.created_at.clone())
                .unwrap_or_else(|| iso(now())),
            updated_at: iso(now()),
            files,
            apps,
        }
    };
    if revoke {
        share.status = "revoked".into();
    }
    share.revision = uuid::Uuid::new_v4().to_string();
    let same_access = old.as_ref().is_some_and(|previous| {
        !revoke
            && previous.status == "active"
            && previous.target_team_id == share.target_team_id
            && previous.audience == share.audience
            && previous.member_ids == share.member_ids
            && previous.files.as_deref().unwrap_or(&[]) == share.files.as_deref().unwrap_or(&[])
            && previous.apps.as_deref().unwrap_or(&[]) == share.apps.as_deref().unwrap_or(&[])
    });
    share.access_revision = if same_access {
        old.as_ref().unwrap().access_revision.clone()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    share.updated_at = iso(now());
    super::resources::validate_grants(&share)?;
    SharedBots::put(&mut tx, &share).await?;
    sqlx::query(
        "INSERT INTO shared_bot_mutations(actor_id,request_id,digest,share_id) VALUES(?,?,?,?)",
    )
    .bind(&grant.user_id)
    .bind(request)
    .bind(digest)
    .bind(&share.id)
    .execute(&mut *tx)
    .await?;
    source_owner(state, grant, agent).await?;
    if !revoke {
        authorize_share(state, &grant.user_id, &share).await?;
    }
    grant.authorize_owner(state).await?;
    for guard in file_guards {
        guard.authorize(state).await?;
    }
    if !revoke && body.get("apps").is_some() {
        for app in share.apps.as_deref().unwrap_or(&[]) {
            super::source_apps::selected_tools(state, &workspace, app).await?;
        }
    }
    grant.authorize_owner(state).await?;
    tx.commit().await?;
    state.changed(None, None, None);
    state.workspace.emit_all("update", json!({})).await;
    Ok(())
}
