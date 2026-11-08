use super::{draft, store};
use crate::{
    db::State,
    error::{ApiError, Result, only_fields},
    workspace::{Table, WorkspaceAccess, WorkspaceStore, groups, mutations as bots},
};
use serde_json::{Value, json};

fn ready(saved: &Value, body: &Value) -> Result<()> {
    draft::uuid(&body["expectedRevision"])?;
    if saved["plan"]["status"] != "ready" || saved["plan"]["revision"] != body["expectedRevision"] {
        return Err(ApiError::new(409, "团队方案已变化或尚未就绪，请重新查看。"));
    }
    Ok(())
}
pub async fn revise(
    state: &State,
    grant: &WorkspaceAccess,
    ws: &WorkspaceStore,
    id: &str,
    body: &Value,
) -> Result<Value> {
    only_fields(body, &["expectedRevision", "draft"])?;
    let mut tx = ws.begin().await?;
    grant.authorize_owner(state).await?;
    let mut saved = store::get(&mut tx, id).await?;
    ready(&saved, body)?;
    super::live::source(state, grant, &mut tx, &saved).await?;
    let agents = super::live::agents(state, grant, &mut tx).await?;
    saved["plan"]["draft"] = draft::validate(
        &mut tx,
        &body["draft"],
        &agents,
        Some(&saved["catalog"]),
        true,
        true,
    )
    .await?;
    store::stamp(&mut saved);
    let card = store::save(&mut tx, &saved).await?;
    super::live::recheck(state, grant, &agents, &saved["plan"]["draft"]).await?;
    tx.commit().await?;
    store::notify(ws, card);
    Ok(saved["plan"].clone())
}
pub async fn cancel(
    state: &State,
    grant: &WorkspaceAccess,
    ws: &WorkspaceStore,
    id: &str,
) -> Result<Value> {
    let mut tx = ws.begin().await?;
    grant.authorize_owner(state).await?;
    let mut saved = store::get(&mut tx, id).await?;
    if saved["plan"]["status"] == "committed" {
        return Err(ApiError::new(409, "团队已创建，不能取消原方案。"));
    }
    saved["plan"]["status"] = json!("cancelled");
    saved["plan"]["error"] = json!("已取消团队方案，目标和草稿已保留。");
    store::stamp(&mut saved);
    let card = store::save(&mut tx, &saved).await?;
    grant.authorize_owner(state).await?;
    tx.commit().await?;
    ws.team_jobs.cancel(id);
    store::notify(ws, card);
    Ok(saved["plan"].clone())
}
pub async fn commit(
    state: &State,
    grant: &WorkspaceAccess,
    ws: &WorkspaceStore,
    id: &str,
    body: &Value,
) -> Result<Value> {
    only_fields(body, &["requestId", "expectedRevision", "draft"])?;
    draft::uuid(&body["requestId"])?;
    draft::uuid(&body["expectedRevision"])?;
    let digest =
        draft::digest(&json!({"expectedRevision":body["expectedRevision"],"draft":body["draft"]}));
    let mut tx = ws.begin().await?;
    grant.authorize_owner(state).await?;
    let mut saved = store::get(&mut tx, id).await?;
    if saved["plan"]["status"] == "committed" {
        if saved["commit"]["requestId"] != body["requestId"] || saved["commit"]["digest"] != digest
        {
            return Err(ApiError::new(409, "此方案已确认，不能用不同内容再次创建。"));
        }
        grant.authorize_owner(state).await?;
        tx.commit().await?;
        return Ok(saved["plan"].clone());
    }
    ready(&saved, body)?;
    super::live::source(state, grant, &mut tx, &saved).await?;
    if sqlx::query("SELECT 1 FROM bot_team_plans WHERE commit_request_id=?")
        .bind(body["requestId"].as_str())
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    {
        return Err(ApiError::new(409, "此确认请求已用于其他方案。"));
    }
    let agents = super::live::agents(state, grant, &mut tx).await?;
    let proposal = draft::validate(&mut tx, &body["draft"], &agents, None, true, false).await?;
    let members = proposal["members"].as_array().unwrap();
    let mut ids = std::collections::HashMap::new();
    let mut created = Vec::new();
    for member in members {
        let agent = if member["kind"] == "reuse" {
            let agent = agents
                .iter()
                .find(|a| a["id"] == member["agentId"])
                .unwrap();
            if saved["catalog"][member["agentId"].as_str().unwrap()] != draft::version(agent) {
                return Err(ApiError::new(
                    409,
                    "复用 Bot 资料已变化，请核对并接纳最新资料。",
                ));
            }
            agent.clone()
        } else {
            let mut profile = member.clone();
            for k in ["key", "kind", "assignment"] {
                profile.as_object_mut().unwrap().remove(k);
            }
            let (agent, _) = bots::create_bot(&mut tx, &profile).await?;
            created.push(agent["id"].clone());
            agent
        };
        ids.insert(
            member["key"].as_str().unwrap().to_owned(),
            agent["id"].clone(),
        );
    }
    let lead = ids[proposal["leadKey"].as_str().unwrap()].clone();
    let mut all = vec![lead.clone()];
    for member in members {
        if member["key"] != proposal["leadKey"] {
            all.push(ids[member["key"].as_str().unwrap()].clone());
        }
    }
    let mut chat = groups::create(
        &mut tx,
        &json!({"title":proposal["title"],"agentIds":all,"isGroup":true}),
    )
    .await?;
    chat["teamBrief"] = json!({"goal":saved["plan"]["goal"],"summary":proposal["summary"],"leadAgentId":lead,"assignments":members.iter().map(|m|json!({"agentId":ids[m["key"].as_str().unwrap()],"assignment":m["assignment"]})).collect::<Vec<_>>()});
    WorkspaceStore::put_in(&mut tx, Table::Conversations, &chat).await?;
    saved["plan"]["draft"] = proposal;
    saved["plan"]["status"] = json!("committed");
    saved["plan"]["result"] = json!({"conversationId":chat["id"],"createdAgentIds":created,"memberAgentIds":all,"leadAgentId":lead});
    saved["plan"].as_object_mut().unwrap().remove("error");
    saved["commit"] = json!({"requestId":body["requestId"],"digest":digest});
    store::stamp(&mut saved);
    let card = store::save(&mut tx, &saved).await?;
    super::live::recheck(state, grant, &agents, &saved["plan"]["draft"]).await?;
    tx.commit().await?;
    store::notify(ws, card);
    Ok(saved["plan"].clone())
}
