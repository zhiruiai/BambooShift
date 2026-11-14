use super::blueprint::{self, Snapshot};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, text},
    workspace::{Table, WorkspaceAccess, WorkspaceStore, avatar_jobs, mutations, time_zone},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
#[derive(Default)]
pub struct InstallJobs(Mutex<HashSet<String>>);
struct InstallLease(Arc<InstallJobs>, String);
impl Drop for InstallLease {
    fn drop(&mut self) {
        self.0.0.lock().unwrap().remove(&self.1);
    }
}
impl InstallJobs {
    pub fn pending(&self, id: &str) -> bool {
        self.0.lock().unwrap().contains(id)
    }
    fn reserve(self: &Arc<Self>, id: &str) -> Result<InstallLease> {
        let mut jobs = self.0.lock().unwrap();
        if jobs.contains(id) {
            return Err(ApiError::new(409, "这次 Bot 创建仍在处理，请核对原回执。")
                .with_code("BOT_INSTALL_PENDING"));
        }
        if !jobs.is_empty() {
            return Err(ApiError::new(429, "当前空间正在创建 Bot，请稍后重试。"));
        }
        jobs.insert(id.to_owned());
        Ok(InstallLease(self.clone(), id.to_owned()))
    }
}
pub(super) fn actor(grant: &WorkspaceAccess) -> String {
    format!("user:{}", grant.user_id)
}

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS bot_install_receipts(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL)").execute(conn).await?;
    Ok(())
}
pub(super) async fn saved(
    conn: &mut SqliteConnection,
    actor: &str,
    id: &str,
    digest: Option<&str>,
) -> Result<Option<Value>> {
    let row =
        sqlx::query("SELECT actor_id,digest,data FROM bot_install_receipts WHERE request_id=?")
            .bind(id)
            .fetch_optional(conn)
            .await?;
    let Some(row) = row else { return Ok(None) };
    if row.get::<String, _>("actor_id") != actor {
        return Err(
            ApiError::new(409, "这个创建请求已用于其他内容。").with_code("BOT_INSTALL_CONFLICT")
        );
    }
    if digest.is_some_and(|d| row.get::<String, _>("digest") != d) {
        return Err(
            ApiError::new(409, "这个创建请求已用于其他内容，请核对原回执。")
                .with_code("BOT_INSTALL_CONFLICT"),
        );
    }
    let value: Value = serde_json::from_str(row.get("data"))
        .map_err(|_| ApiError::new(409, "创建回执暂不可用，请核对已有 Bot。"))?;
    if value["requestId"] != id
        || value["agentId"].as_str().is_none()
        || value["conversationId"].as_str().is_none()
        || !value["skillIds"].is_array()
        || !value["routineIds"].is_array()
    {
        return Err(ApiError::new(409, "创建回执来源不一致。"));
    }
    Ok(Some(value))
}
pub(super) async fn load(
    state: &State,
    grant: &WorkspaceAccess,
    conn: &mut SqliteConnection,
    source: &Value,
) -> Result<Snapshot> {
    let snapshot = match source["kind"].as_str() {
        Some("bot") => blueprint::capture(conn, blueprint::opaque(&source["id"])?).await?,
        Some("template") => {
            super::published::read(
                state,
                blueprint::opaque(&source["id"])?,
                Some(&grant.user_id),
            )
            .await?
            .snapshot
        }
        _ => return Err(ApiError::bad("Bot 复制来源无效。")),
    };
    if snapshot.revision != source["revision"] {
        return Err(
            ApiError::new(409, "来源 Bot 或模板已变化，请重新预览后确认。")
                .with_code("BOT_SOURCE_CHANGED"),
        );
    }
    Ok(snapshot)
}
pub(super) async fn install(
    state: State,
    grant: WorkspaceAccess,
    id: String,
    source: Value,
    name: Value,
    mode: Value,
) -> Result<Value> {
    blueprint::uuid(&json!(id))?;
    blueprint::opaque(&source["id"])?;
    blueprint::opaque(&source["revision"])?;
    text(&name, "Bot 名称", 40)?;
    if !matches!(mode.as_str(), Some("preserve" | "pause")) {
        return Err(ApiError::bad("请选择如何处理例行任务。"));
    }
    let digest = blueprint::hash(&json!({"source":source,"name":name,"routineMode":mode}));
    let store = grant.store(&state).await?;
    grant.authorize_owner(&state).await?;
    let admission = store.bot_installs.reserve(&id);
    let mut tx = store.pool.begin().await?;
    if let Some(prior) = saved(&mut tx, &actor(&grant), &id, Some(&digest)).await? {
        grant.authorize_owner(&state).await?;
        return Ok(prior);
    }
    let pending = admission?;
    let operation = if source["kind"] == "template" {
        Some(state.bot_templates.operations.clone().lock_owned().await)
    } else {
        None
    };
    let snapshot = load(&state, &grant, &mut tx, &source).await?;
    tx.commit().await?;
    grant.authorize_owner(&state).await?;
    let input = Install {
        id,
        source,
        name,
        mode,
        digest,
        snapshot,
        _pending: pending,
        _operation: operation,
    };
    if let Some(bytes) = &input.snapshot.avatar {
        let encoded = STANDARD.encode(bytes);
        let lease = avatar_jobs::active(&store).await?;
        lease
            .run(move |job| async move {
                let output = avatar_jobs::process(
                    &job,
                    &state,
                    &grant,
                    json!({"op":"portable","bytes":encoded,"crop":null}),
                )
                .await?;
                let encoded = output["bytes"]
                    .as_str()
                    .filter(|v| v.len() <= (512 * 1024_usize).div_ceil(3) * 4)
                    .ok_or_else(|| ApiError::bad("模板头像处理失败。"))?;
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| ApiError::bad("模板头像处理失败。"))?;
                if bytes.len() > 512 * 1024 || output["width"] != 512 || output["height"] != 512 {
                    return Err(ApiError::bad("模板头像尺寸无效。"));
                }
                perform(&state, &grant, &store, input, Some(bytes), Some(&job)).await
            })
            .await
    } else {
        perform(&state, &grant, &store, input, None, None).await
    }
}
struct Install {
    id: String,
    source: Value,
    name: Value,
    mode: Value,
    digest: String,
    snapshot: Snapshot,
    _pending: InstallLease,
    _operation: Option<tokio::sync::OwnedMutexGuard<()>>,
}
async fn perform(
    state: &State,
    grant: &WorkspaceAccess,
    store: &Arc<WorkspaceStore>,
    input: Install,
    avatar: Option<Vec<u8>>,
    job: Option<&avatar_jobs::Cancellation>,
) -> Result<Value> {
    let check = || {
        if state.is_closing() || store.is_closed() {
            return Err(ApiError::new(503, "Bot 创建服务正在关闭。"));
        }
        if let Some(job) = job {
            job.check()?;
        }
        Ok(())
    };
    check()?;
    let mut tx = store.begin().await?;
    if let Some(prior) = saved(&mut tx, &actor(grant), &input.id, Some(&input.digest)).await? {
        grant.authorize_owner(state).await?;
        check()?;
        return Ok(prior);
    }
    let current = load(state, grant, &mut tx, &input.source).await?;
    if current.blueprint != input.snapshot.blueprint {
        return Err(ApiError::new(409, "来源内容已变化，请重新预览。"));
    }
    let at = now();
    let mut profile = current.blueprint["profile"].clone();
    profile["name"] = json!(text(&input.name, "Bot 名称", 40)?);
    if let Some(bytes) = avatar {
        let row = sqlx::query(
            "SELECT count(*) AS count,coalesce(sum(length(bytes)),0) AS size FROM avatar_assets",
        )
        .fetch_one(&mut *tx)
        .await?;
        if row.get::<i64, _>("count") >= 512
            || row.get::<i64, _>("size") + bytes.len() as i64 > 64 * 1024 * 1024
        {
            return Err(ApiError::new(409, "当前空间头像存储已达上限。"));
        }
        let asset = json!({"id":uuid::Uuid::new_v4().to_string(),"width":512,"height":512,"mimeType":"image/webp","createdAt":iso(at)});
        sqlx::query("INSERT INTO avatar_assets(id,data,bytes,published) VALUES(?,?,?,0)")
            .bind(asset["id"].as_str())
            .bind(asset.to_string())
            .bind(bytes)
            .execute(&mut *tx)
            .await?;
        profile["avatarImageId"] = asset["id"].clone();
    }
    let (agent, chat) = mutations::create_bot(store, &mut tx, &profile).await?;
    let mut skill_ids = Vec::new();
    for value in current.blueprint["skills"].as_array().unwrap() {
        let mut skill = value.clone();
        let id = uuid::Uuid::new_v4().to_string();
        for (key,value) in json!({"id":id,"agentId":agent["id"],"version":1,"status":"active","createdAt":iso(at),"approvedAt":iso(at),"activatedAt":iso(at)}).as_object().unwrap() {skill[key]=value.clone();}
        WorkspaceStore::put_in(&mut tx, Table::Skills, &skill).await?;
        skill_ids.push(id);
    }
    let mut routine_ids = Vec::new();
    for value in current.blueprint["routines"].as_array().unwrap() {
        let mut routine = value.clone();
        let id = uuid::Uuid::new_v4().to_string();
        routine["id"] = json!(id);
        routine["agentId"] = agent["id"].clone();
        routine["conversationId"] = chat["id"].clone();
        routine["enabled"] = json!(input.mode == "preserve" && value["enabled"] == true);
        routine["timeZone"] = json!(time_zone::effective(value.get("timeZone"))?);
        routine["nextRunAt"] = json!(time_zone::next(
            routine["schedule"].as_str().unwrap(),
            at,
            routine.get("timeZone")
        )?);
        WorkspaceStore::put_in(&mut tx, Table::Routines, &routine).await?;
        routine_ids.push(id);
    }
    let receipt = json!({"requestId":input.id,"agentId":agent["id"],"conversationId":chat["id"],"skillIds":skill_ids,"routineIds":routine_ids,"createdAt":iso(at)});
    sqlx::query(
        "INSERT INTO bot_install_receipts(request_id,actor_id,digest,data) VALUES(?,?,?,?)",
    )
    .bind(&input.id)
    .bind(actor(grant))
    .bind(&input.digest)
    .bind(receipt.to_string())
    .execute(&mut *tx)
    .await?;
    grant.authorize_owner(state).await?;
    let final_source = load(state, grant, &mut tx, &input.source).await?;
    if final_source.blueprint != current.blueprint {
        return Err(ApiError::new(409, "来源授权或内容已变化，请重新预览。"));
    }
    check()?;
    tx.commit().await?;
    store.emit("update", json!({}));
    grant.authorize_owner(state).await?;
    Ok(receipt)
}
