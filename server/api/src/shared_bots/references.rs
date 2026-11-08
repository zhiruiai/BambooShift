use super::{
    catalog,
    resources::request_uuid,
    source::{self, SourceDatabase},
    store::{sha, unavailable, uuid},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields},
    workspace::{Table, WorkspaceAccess, WorkspaceStore},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reference {
    pub share_id: String,
    pub owner_user_id: String,
    pub agent_id: String,
    pub conversation_id: String,
    pub created_at: String,
}
pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS shared_bot_refs(share_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL)").execute(&mut *conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS shared_bot_add_receipts(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL)").execute(conn).await?;
    Ok(())
}
pub(crate) async fn personal(state: &State, grant: &WorkspaceAccess) -> Result<source::Workspace> {
    grant.authorize_owner(state).await?;
    let ws = source::workspace(state, &grant.workspace_id).await?;
    if ws.kind != "personal" {
        return Err(ApiError::new(
            403,
            "共享Bot的私人会话只能放在本人的个人空间。",
        ));
    }
    Ok(ws)
}
pub(crate) async fn by_agent(conn: &mut SqliteConnection, id: &str) -> Result<Option<Reference>> {
    let row = sqlx::query("SELECT share_id,agent_id,data FROM shared_bot_refs WHERE agent_id=?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(|r| {
        let data: String = r.get("data");
        let reference: Reference = serde_json::from_str(&data).map_err(|_| unavailable())?;
        if reference.agent_id != r.get::<String, _>("agent_id")
            || reference.share_id != r.get::<String, _>("share_id")
            || ![
                &reference.share_id,
                &reference.owner_user_id,
                &reference.agent_id,
                &reference.conversation_id,
            ]
            .iter()
            .all(|v| uuid(v))
        {
            return Err(unavailable());
        }
        Ok(reference)
    })
    .transpose()
}
pub(crate) async fn validate(
    conn: &mut SqliteConnection,
    reference: &Reference,
    user: &str,
) -> Result<Value> {
    if reference.owner_user_id != user {
        return Err(unavailable());
    }
    let agent = WorkspaceStore::get_in(conn, Table::Agents, &reference.agent_id)
        .await?
        .ok_or_else(unavailable)?;
    let chat = WorkspaceStore::get_in(conn, Table::Conversations, &reference.conversation_id)
        .await?
        .ok_or_else(unavailable)?;
    if agent["sharedBot"]["shareId"] != reference.share_id
        || chat["isGroup"] != false
        || chat["agentIds"] != json!([reference.agent_id])
    {
        return Err(unavailable());
    }
    Ok(agent)
}
pub(crate) async fn receipt(
    conn: &mut SqliteConnection,
    request: &str,
    user: &str,
    wid: &str,
) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT actor_id,data FROM shared_bot_add_receipts WHERE request_id=?")
        .bind(request)
        .fetch_optional(conn)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.get::<String, _>("actor_id") != user {
        return Err(unavailable());
    }
    let value: Value =
        serde_json::from_str(&row.get::<String, _>("data")).map_err(|_| unavailable())?;
    if value["requestId"] != request
        || value["actorId"] != user
        || value["workspaceId"] != wid
        || !["shareId", "agentId", "conversationId"]
            .iter()
            .all(|k| value[*k].as_str().is_some_and(uuid))
    {
        return Err(unavailable());
    }
    Ok(Some(value))
}
pub async fn peek_receipt(
    state: &State,
    grant: &WorkspaceAccess,
    request: &str,
) -> Result<Option<Value>> {
    if !uuid(request) {
        return Err(ApiError::bad("请求标识无效。"));
    }
    let workspace = personal(state, grant).await?;
    let path = if workspace.key == "legacy" {
        state.config.data_dir.join("openbot.sqlite")
    } else {
        state
            .config
            .data_dir
            .join("spaces")
            .join(&workspace.id)
            .join("openbot.sqlite")
    };
    if !path.try_exists()? {
        return Ok(None);
    }
    let mut db = SourceDatabase::open(state, &workspace).await?;
    if !db.exists("shared_bot_add_receipts").await? {
        return Ok(None);
    }
    let value = receipt(&mut db.conn, request, &grant.user_id, &grant.workspace_id).await?;
    db.check()?;
    grant.authorize_owner(state).await?;
    Ok(value)
}
pub async fn add(state: &State, grant: &WorkspaceAccess, body: &Value) -> Result<Value> {
    only_fields(body, &["requestId", "shareId"])?;
    let request = request_uuid(body, "requestId")?;
    let id = request_uuid(body, "shareId")?;
    personal(state, grant).await?;
    let store = grant.store(state).await?;
    let digest = sha(serde_json::to_vec(&json!([grant.user_id, grant.workspace_id, id])).unwrap());
    let mut tx = store.begin().await?;
    if let Some(row) =
        sqlx::query("SELECT actor_id,digest FROM shared_bot_add_receipts WHERE request_id=?")
            .bind(&request)
            .fetch_optional(&mut *tx)
            .await?
    {
        if row.get::<String, _>("actor_id") != grant.user_id
            || row.get::<String, _>("digest") != digest
        {
            return Err(ApiError::new(409, "加入请求已用于其他Bot。"));
        }
        let value = receipt(&mut tx, &request, &grant.user_id, &grant.workspace_id)
            .await?
            .ok_or_else(unavailable)?;
        grant.authorize_owner(state).await?;
        tx.commit().await?;
        return Ok(value);
    }
    let definition = catalog::definition(state, &grant.user_id, &id).await?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT agent_id FROM shared_bot_refs WHERE share_id=?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let reference = if let Some(agent) = existing {
        let reference = by_agent(&mut tx, &agent).await?.ok_or_else(unavailable)?;
        validate(&mut tx, &reference, &grant.user_id).await?;
        reference
    } else {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM shared_bot_refs")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 1000 {
            return Err(ApiError::new(409, "个人共享Bot已达数量上限。"));
        }
        let reference = Reference {
            share_id: id.clone(),
            owner_user_id: grant.user_id.clone(),
            agent_id: uuid::Uuid::new_v4().to_string(),
            conversation_id: uuid::Uuid::new_v4().to_string(),
            created_at: iso(now()),
        };
        let mut agent = definition.source.profile.clone();
        agent["id"] = json!(reference.agent_id);
        agent["configRevision"] = json!(uuid::Uuid::new_v4().to_string());
        agent["status"] = json!("idle");
        agent["avatarImageId"] = Value::Null;
        agent["sharedBot"] = catalog::metadata(&definition);
        WorkspaceStore::put_in(&mut tx, Table::Agents, &agent).await?;
        WorkspaceStore::put_in(&mut tx,Table::Conversations,&json!({"id":reference.conversation_id,"title":agent["name"],"agentIds":[reference.agent_id],"isGroup":false,"updatedAt":reference.created_at,"unread":0,"pinned":false})).await?;
        sqlx::query("INSERT INTO shared_bot_refs(share_id,agent_id,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(&reference.agent_id)
            .bind(serde_json::to_string(&reference).unwrap())
            .execute(&mut *tx)
            .await?;
        reference
    };
    unhide(&mut tx, &grant.user_id, &reference.agent_id).await?;
    let value = json!({"requestId":request,"shareId":id,"actorId":grant.user_id,"workspaceId":grant.workspace_id,"agentId":reference.agent_id,"conversationId":reference.conversation_id,"createdAt":iso(now())});
    sqlx::query(
        "INSERT INTO shared_bot_add_receipts(request_id,actor_id,digest,data) VALUES(?,?,?,?)",
    )
    .bind(request)
    .bind(&grant.user_id)
    .bind(digest)
    .bind(value.to_string())
    .execute(&mut *tx)
    .await?;
    let current = state.shared_bots.get(&id).await?;
    if current.access_revision != definition.share.access_revision {
        return Err(unavailable());
    }
    catalog::authorize_share(state, &grant.user_id, &current).await?;
    grant.authorize_owner(state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(value)
}
async fn unhide(conn: &mut SqliteConnection, user: &str, agent: &str) -> Result<()> {
    let actor = format!("user:{user}");
    let row: Option<String> =
        sqlx::query_scalar("SELECT data FROM sidebar_rosters WHERE actor_id=?")
            .bind(&actor)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(raw) = row else {
        return Ok(());
    };
    let mut value: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
    let mut changed = false;
    if let Some(entries) = value["entries"].as_array_mut() {
        for entry in entries {
            if entry["target"]["kind"] == "bot"
                && entry["target"]["id"] == agent
                && entry["hidden"] == true
            {
                entry["hidden"] = json!(false);
                changed = true;
            }
        }
    }
    if changed {
        value["revision"] = json!(uuid::Uuid::new_v4().to_string());
        sqlx::query("UPDATE sidebar_rosters SET data=? WHERE actor_id=?")
            .bind(value.to_string())
            .bind(actor)
            .execute(conn)
            .await?;
    }
    Ok(())
}
pub async fn joined(
    state: &State,
    grant: &WorkspaceAccess,
) -> Result<std::collections::HashMap<String, Value>> {
    let workspace = personal(state, grant).await?;
    let mut result = std::collections::HashMap::new();
    let path = if workspace.key == "legacy" {
        state.config.data_dir.join("openbot.sqlite")
    } else {
        state
            .config
            .data_dir
            .join("spaces")
            .join(&workspace.id)
            .join("openbot.sqlite")
    };
    if !path.try_exists()? {
        return Ok(result);
    }
    let mut db = SourceDatabase::open(state, &workspace).await?;
    if !db.exists("shared_bot_refs").await? {
        return Ok(result);
    }
    let ids: Vec<String> = sqlx::query_scalar("SELECT agent_id FROM shared_bot_refs")
        .fetch_all(&mut db.conn)
        .await?;
    let roster: Option<String> = if db.exists("sidebar_rosters").await? {
        sqlx::query_scalar("SELECT data FROM sidebar_rosters WHERE actor_id=?")
            .bind(format!("user:{}", grant.user_id))
            .fetch_optional(&mut db.conn)
            .await?
    } else {
        None
    };
    let roster: Value = roster
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or(json!({}));
    for id in ids {
        if let Ok(Some(r)) = by_agent(&mut db.conn, &id).await {
            if validate(&mut db.conn, &r, &grant.user_id).await.is_ok() {
                let hidden = roster["entries"].as_array().is_some_and(|es| {
                    es.iter().any(|e| {
                        e["target"]["kind"] == "bot"
                            && e["target"]["id"] == id
                            && e["hidden"] == true
                    })
                });
                result.insert(r.share_id,json!({"workspaceId":grant.workspace_id,"agentId":id,"conversationId":r.conversation_id,"hidden":hidden}));
            }
        }
    }
    db.check()?;
    grant.authorize_owner(state).await?;
    Ok(result)
}
