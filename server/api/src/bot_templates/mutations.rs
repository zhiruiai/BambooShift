use super::{
    blueprint,
    store::{self, Template},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(super) async fn apply(
    state: &State,
    grant: &WorkspaceAccess,
    operation: &str,
    id: Option<&str>,
    body: &Value,
) -> Result<Value> {
    state.bot_templates.ensure_open()?;
    only_fields(
        body,
        match operation {
            "create" => &[
                "requestId",
                "sourceAgentId",
                "sourceConversationId",
                "expectedSourceRevision",
            ],
            "edit" => &[
                "requestId",
                "expectedRevision",
                "expectedDraftRevision",
                "blueprint",
            ],
            "refresh" => &["requestId", "expectedRevision", "expectedSourceRevision"],
            "publish" => &[
                "requestId",
                "expectedRevision",
                "expectedDraftRevision",
                "audience",
            ],
            "revoke" => &["requestId", "expectedRevision"],
            _ => return Err(ApiError::bad("模板操作无效。")),
        },
    )?;
    let request = blueprint::uuid(&body["requestId"])?;
    let _pending = state.bot_templates.reserve(&grant.user_id, request)?;
    let _operation = state.bot_templates.operations.lock().await;
    grant.authorize_owner(state).await?;
    let mut payload = body.clone();
    payload["operation"] = json!(operation);
    if let Some(id) = id {
        payload["id"] = json!(id);
    }
    let digest = blueprint::hash(&json!({"workspaceId":grant.workspace_id,"payload":payload}));
    if let Some(prior) = store::prior(
        &mut *state.bot_templates.pool.acquire().await?,
        grant,
        request,
        Some(&digest),
    )
    .await?
    {
        grant.authorize_owner(state).await?;
        return Ok(store::view(&prior.row));
    }
    // Source locking ends after the central commit; a refresh never silently captures a newer source.
    let workspace = if matches!(operation, "create" | "refresh") {
        Some(grant.store(state).await?)
    } else {
        None
    };
    let mut source_tx = match &workspace {
        Some(store) => Some(store.begin().await?),
        None => None,
    };
    let snapshot = if let Some(tx) = source_tx.as_mut() {
        let agent = if operation == "create" {
            blueprint::opaque(&body["sourceAgentId"])?.to_owned()
        } else {
            let value = store::read(
                &mut *state.bot_templates.pool.acquire().await?,
                &grant.workspace_id,
                id.unwrap_or(""),
            )
            .await?;
            value.row["sourceAgentId"]
                .as_str()
                .ok_or_else(|| ApiError::new(409, "模板来源无效。"))?
                .to_owned()
        };
        if operation == "create" {
            let chat = WorkspaceStore::get_in(
                tx,
                Table::Conversations,
                blueprint::opaque(&body["sourceConversationId"])?,
            )
            .await?
            .ok_or_else(|| ApiError::new(409, "来源单聊不存在。"))?;
            if chat["isGroup"] != false || chat["agentIds"] != json!([agent]) {
                return Err(ApiError::new(
                    409,
                    "请选择这位 Bot 已有的单聊作为模板卡来源。",
                ));
            }
        }
        let snapshot = blueprint::capture(tx, &agent).await?;
        if body["expectedSourceRevision"] != snapshot.revision {
            return Err(ApiError::new(409, "Bot 配置已变化，请重新预览。"));
        }
        Some(snapshot)
    } else {
        None
    };
    let mut tx = state
        .bot_templates
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await?;
    if let Some(prior) = store::prior(&mut tx, grant, request, Some(&digest)).await? {
        grant.authorize_owner(state).await?;
        return Ok(store::view(&prior.row));
    }
    grant.authorize_owner(state).await?;
    let value = if operation == "create" {
        if store::policy(&mut tx, &grant.workspace_id, &grant.kind).await?["mode"] == "disabled" {
            return Err(ApiError::new(403, "当前空间已停用模板分享。"));
        }
        let snapshot = snapshot.as_ref().unwrap();
        let at = iso(now());
        Template {
            row: json!({"id":uuid::Uuid::new_v4().to_string(),"workspaceId":grant.workspace_id,"createdBy":grant.user_id,"sourceAgentId":body["sourceAgentId"],"sourceConversationId":body["sourceConversationId"],"sourceName":snapshot.blueprint["profile"]["name"],"messageId":uuid::Uuid::new_v4().to_string(),"sequence":1,"revision":uuid::Uuid::new_v4().to_string(),"draftRevision":uuid::Uuid::new_v4().to_string(),"draftDigest":blueprint::hash(&snapshot.blueprint),"blueprint":snapshot.blueprint,"revoked":false,"projectionPending":true,"createdAt":at,"updatedAt":at}),
            avatar: snapshot.avatar.clone(),
        }
    } else {
        let mut value = store::read(&mut tx, &grant.workspace_id, id.unwrap_or("")).await?;
        store::revision(&value.row, body, matches!(operation, "edit" | "publish"))?;
        match operation {
            "edit" => {
                if let Some(avatar) = body["blueprint"].get("avatar") {
                    if avatar != &value.row["blueprint"]["avatar"] {
                        return Err(ApiError::bad(
                            "模板头像只能保留或移除；更换图片请从 Bot 更新。",
                        ));
                    }
                }
                if body["blueprint"].get("avatar").is_none() {
                    value.avatar = None;
                }
                value.row["blueprint"] =
                    blueprint::validate(&body["blueprint"], value.avatar.as_deref())?;
                value.row["draftRevision"] = json!(uuid::Uuid::new_v4().to_string());
                value.row["draftDigest"] = json!(blueprint::hash(&value.row["blueprint"]));
            }
            "refresh" => {
                let snapshot = snapshot.as_ref().unwrap();
                value.row["blueprint"] = snapshot.blueprint.clone();
                value.row["sourceName"] = snapshot.blueprint["profile"]["name"].clone();
                value.row["draftRevision"] = json!(uuid::Uuid::new_v4().to_string());
                value.row["draftDigest"] = json!(blueprint::hash(&snapshot.blueprint));
                value.avatar = snapshot.avatar.clone();
            }
            "publish" => publish(state, grant, &mut tx, &mut value, &body["audience"]).await?,
            "revoke" => revoke(&mut tx, &mut value.row).await?,
            _ => unreachable!(),
        }
        store::touch(&mut value.row);
        value
    };
    store::save(&mut tx, &value).await?;
    store::quota(&mut tx, &grant.workspace_id).await?;
    sqlx::query("INSERT INTO template_mutations(actor_id,request_id,workspace_id,digest,template_id) VALUES(?,?,?,?,?)").bind(&grant.user_id).bind(request).bind(&grant.workspace_id).bind(digest).bind(value.row["id"].as_str()).execute(&mut *tx).await?;
    grant.authorize_owner(state).await?;
    if state.is_closing() {
        return Err(ApiError::new(503, "模板服务正在关闭。"));
    }
    tx.commit().await?;
    if let Some(tx) = source_tx {
        tx.rollback().await?;
    }
    grant.authorize_owner(state).await?;
    Ok(store::view(&value.row))
}
async fn publish(
    state: &State,
    grant: &WorkspaceAccess,
    conn: &mut SqliteConnection,
    value: &mut Template,
    audience: &Value,
) -> Result<()> {
    if !matches!(audience.as_str(), Some("public" | "team")) {
        return Err(ApiError::bad("请选择有效的分享范围。"));
    }
    let policy = store::policy(conn, &grant.workspace_id, &grant.kind).await?;
    if policy["mode"] == "disabled"
        || audience == "public" && policy["mode"] != "public"
        || audience == "team" && grant.kind != "team"
    {
        return Err(ApiError::new(403, "当前空间不允许使用这个分享范围。"));
    }
    store::source_available(
        state,
        &grant.workspace_id,
        value.row["createdBy"].as_str().unwrap(),
    )
    .await?;
    let same = value.row["publication"]["audience"] == *audience;
    let token = if same {
        value.row["publication"]["token"]
            .as_str()
            .unwrap()
            .to_owned()
    } else {
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    };
    let id = value.row["id"].as_str().unwrap();
    if !same {
        sqlx::query("UPDATE template_links SET revoked=1 WHERE template_id=?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    let version = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO template_versions(id,template_id,workspace_id,data,avatar) VALUES(?,?,?,?,?)",
    )
    .bind(&version)
    .bind(id)
    .bind(&grant.workspace_id)
    .bind(json!({"blueprint":value.row["blueprint"],"digest":value.row["draftDigest"]}).to_string())
    .bind(&value.avatar)
    .execute(&mut *conn)
    .await?;
    sqlx::query("INSERT INTO template_links(token,template_id,version_id,revoked) VALUES(?,?,?,0) ON CONFLICT(token) DO UPDATE SET version_id=excluded.version_id").bind(&token).bind(id).bind(&version).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM template_versions WHERE template_id=? AND id<>?")
        .bind(id)
        .bind(&version)
        .execute(&mut *conn)
        .await?;
    value.row["publication"] = json!({"versionId":version,"token":token,"digest":value.row["draftDigest"],"audience":audience,"publishedAt":iso(now())});
    value.row["revoked"] = json!(false);
    Ok(())
}
pub(super) async fn revoke(conn: &mut SqliteConnection, row: &mut Value) -> Result<()> {
    sqlx::query("UPDATE template_links SET revoked=1 WHERE template_id=?")
        .bind(row["id"].as_str())
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM template_versions WHERE template_id=?")
        .bind(row["id"].as_str())
        .execute(conn)
        .await?;
    row.as_object_mut().unwrap().remove("publication");
    row["revoked"] = json!(true);
    Ok(())
}
