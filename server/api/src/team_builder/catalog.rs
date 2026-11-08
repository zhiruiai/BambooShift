use super::{draft, store};
use crate::{
    db::State,
    error::{ApiError, Result, only_fields},
    workspace::{WorkspaceAccess, WorkspaceStore},
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::{Row, SqliteConnection};

async fn review(
    state: &State,
    grant: &WorkspaceAccess,
    conn: &mut SqliteConnection,
    saved: &Value,
    body: &Value,
) -> Result<(Value, Value)> {
    if saved["plan"]["status"] != "ready" || saved["plan"]["revision"] != body["expectedRevision"] {
        return Err(ApiError::new(409, "方案已确认或版本已变化。"));
    }
    super::live::source(state, grant, conn, saved).await?;
    let agents = super::live::agents(state, grant, conn).await?;
    let proposal = draft::validate(conn, &body["draft"], &agents, None, true, true).await?;
    let members:Vec<Value>=proposal["members"].as_array().unwrap().iter().filter(|m|m["kind"]=="reuse").map(|m|{
        let agent=agents.iter().find(|a|a["id"]==m["agentId"]).unwrap();let version=draft::version(agent);
        let previous=&saved["catalog"][m["agentId"].as_str().unwrap()];
        json!({"key":m["key"],"agentId":m["agentId"],"version":version,"state":if previous.is_null(){"added"}else if *previous==version{"unchanged"}else{"changed"},"profile":draft::profile(agent)})
    }).collect();
    let mut manifest = json!({"planId":saved["plan"]["id"],"expectedRevision":saved["plan"]["revision"],"draftDigest":draft::digest(&proposal),"members":members});
    let key: String =
        sqlx::query_scalar("SELECT value FROM bot_team_catalog_keys WHERE id='review'")
            .fetch_one(conn)
            .await?;
    let key = hex::decode(key).map_err(|_| ApiError::new(503, "资料核对服务不可用。"))?;
    if key.len() != 32 {
        return Err(ApiError::new(503, "资料核对服务不可用。"));
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|_| ApiError::new(503, "资料核对服务不可用。"))?;
    mac.update(manifest.to_string().as_bytes());
    manifest["reviewToken"] = json!(hex::encode(mac.finalize().into_bytes()));
    super::live::recheck(state, grant, &agents, &proposal).await?;
    Ok((proposal, manifest))
}
pub async fn preview(
    state: &State,
    grant: &WorkspaceAccess,
    ws: &WorkspaceStore,
    id: &str,
    body: &Value,
) -> Result<Value> {
    only_fields(body, &["expectedRevision", "draft"])?;
    draft::uuid(&body["expectedRevision"])?;
    let mut tx = ws.pool.begin().await?;
    let saved = store::get(&mut tx, id).await?;
    let (_, review) = review(state, grant, &mut tx, &saved, body).await?;
    grant.authorize_owner(state).await?;
    tx.commit().await?;
    Ok(review)
}
pub async fn receipt(conn: &mut SqliteConnection, id: &str, request: &str) -> Result<Value> {
    let row = sqlx::query(
        "SELECT plan_id,applied_revision FROM bot_team_catalog_refreshes WHERE request_id=?",
    )
    .bind(request)
    .fetch_optional(&mut *conn)
    .await?
    .filter(|r| r.get::<String, _>("plan_id") == id)
    .ok_or_else(|| ApiError::new(404, "尚未找到这次接纳资料的回执。"))?;
    Ok(
        json!({"requestId":request,"planId":id,"appliedRevision":row.get::<String,_>("applied_revision"),"plan":store::get(conn,id).await?["plan"]}),
    )
}
pub async fn refresh(
    state: &State,
    grant: &WorkspaceAccess,
    ws: &WorkspaceStore,
    id: &str,
    body: &Value,
) -> Result<Value> {
    only_fields(
        body,
        &["requestId", "expectedRevision", "draft", "reviewToken"],
    )?;
    let request = draft::uuid(&body["requestId"])?;
    draft::uuid(&body["expectedRevision"])?;
    let token = body["reviewToken"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| ApiError::bad("资料核对令牌无效。"))?;
    let hash = draft::digest(
        &json!({"planId":id,"expectedRevision":body["expectedRevision"],"draft":body["draft"],"reviewToken":token}),
    );
    let mut tx = ws.begin().await?;
    grant.authorize_owner(state).await?;
    if let Some(row) =
        sqlx::query("SELECT plan_id,digest FROM bot_team_catalog_refreshes WHERE request_id=?")
            .bind(request)
            .fetch_optional(&mut *tx)
            .await?
    {
        if row.get::<String, _>("plan_id") != id || row.get::<String, _>("digest") != hash {
            return Err(ApiError::new(409, "此核对请求已用于其他内容。"));
        }
        let out = receipt(&mut tx, id, request).await?;
        grant.authorize_owner(state).await?;
        tx.commit().await?;
        return Ok(out);
    }
    let mut saved = store::get(&mut tx, id).await?;
    let original = saved.clone();
    let (proposal, manifest) = review(state, grant, &mut tx, &saved, body).await?;
    use subtle::ConstantTimeEq;
    if token
        .as_bytes()
        .ct_eq(manifest["reviewToken"].as_str().unwrap().as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err(ApiError::new(409, "Bot 资料或草稿已变化，请重新核对。"));
    }
    for member in manifest["members"].as_array().unwrap() {
        saved["catalog"][member["agentId"].as_str().unwrap()] = member["version"].clone();
    }
    saved["plan"]["draft"] = proposal;
    store::stamp(&mut saved);
    let card = store::save(&mut tx, &saved).await?;
    sqlx::query("INSERT INTO bot_team_catalog_refreshes VALUES(?,?,?,?)")
        .bind(request)
        .bind(id)
        .bind(hash)
        .bind(saved["plan"]["revision"].as_str())
        .execute(&mut *tx)
        .await?;
    let out = receipt(&mut tx, id, request).await?;
    let (_, latest) = review(state, grant, &mut tx, &original, body).await?;
    if latest["reviewToken"] != manifest["reviewToken"] {
        return Err(ApiError::new(409, "来源 Bot 资料已变化，请重新核对。"));
    }
    grant.authorize_owner(state).await?;
    tx.commit().await?;
    store::notify(ws, card);
    Ok(out)
}
