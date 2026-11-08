use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::{WorkspaceAccess, WorkspaceStore, access},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub async fn initialize(store: &WorkspaceStore) -> Result<()> {
    let mut tx = store.begin().await?;
    for sql in [
        "CREATE TABLE IF NOT EXISTS app_interactive_rules(
            id TEXT PRIMARY KEY, issuer_id TEXT NOT NULL, digest TEXT NOT NULL,
            connection_id TEXT NOT NULL, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
            status TEXT NOT NULL, data TEXT NOT NULL)",
        "CREATE UNIQUE INDEX IF NOT EXISTS app_interactive_rules_active
            ON app_interactive_rules(issuer_id,digest) WHERE status='active'",
        "CREATE TABLE IF NOT EXISTS app_interactive_uses(
            run_id TEXT NOT NULL, request_key TEXT NOT NULL, action_id TEXT NOT NULL,
            PRIMARY KEY(run_id,request_key))",
    ] {
        sqlx::query(sql).execute(&mut *tx).await?;
    }
    for (table, key, fields) in [
        (
            "app_connections",
            "connection_id",
            &[
                "revision",
                "url",
                "authType",
                "authorization",
                "credentialRef",
                "tools",
                "status",
            ][..],
        ),
        ("conversations", "conversation_id", &["isGroup", "agentIds"]),
        ("agents", "agent_id", &["configRevision", "sharedBot"]),
    ] {
        let changes = fields
            .iter()
            .map(|field| {
                format!(
                    "json_extract(old.data,'$.{field}') IS NOT json_extract(new.data,'$.{field}')"
                )
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        for (event, condition) in [
            ("UPDATE", format!("WHEN {changes}")),
            ("DELETE", String::new()),
        ] {
            sqlx::query(&format!(
                "CREATE TRIGGER IF NOT EXISTS app_interactive_{table}_{event}
                 AFTER {event} ON {table} {condition} BEGIN
                   UPDATE app_interactive_rules SET status='invalidated'
                   WHERE {key}=old.id AND status='active';
                 END"
            ))
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub fn allowed(actor: &WorkspaceAccess) -> bool {
    actor.kind == "personal" && actor.is_owner
}

pub fn changed() -> ApiError {
    ApiError::new(409, "应用授权范围已变化，请查看当前操作后重新确认。")
        .with_code("APP_APPROVAL_RULE_CHANGED")
}

pub async fn active_id(
    tx: &mut SqliteConnection,
    issuer: &str,
    digest: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM app_interactive_rules WHERE issuer_id=? AND digest=? AND status='active'",
    )
    .bind(issuer)
    .bind(digest)
    .fetch_optional(tx)
    .await?)
}

pub async fn still_active(tx: &mut SqliteConnection, id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM app_interactive_rules WHERE id=? AND status='active'",
    )
    .bind(id)
    .fetch_optional(tx)
    .await?
    .is_some())
}

pub async fn insert(
    tx: &mut SqliteConnection,
    issuer: &str,
    digest: &str,
    value: &Value,
) -> Result<()> {
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM app_interactive_rules WHERE issuer_id=? AND status='active'",
    )
    .bind(issuer)
    .fetch_one(&mut *tx)
    .await?;
    if active >= 20 {
        return Err(
            ApiError::new(409, "已保存 20 项应用权限，请撤销一项或仅允许本次操作。")
                .with_code("APP_APPROVAL_RULE_LIMIT"),
        );
    }
    sqlx::query("INSERT INTO app_interactive_rules VALUES(?,?,?,?,?,?,'active',?)")
        .bind(value["id"].as_str())
        .bind(issuer)
        .bind(digest)
        .bind(value["connectionId"].as_str())
        .bind(value["conversationId"].as_str())
        .bind(value["agentId"].as_str())
        .bind(value.to_string())
        .execute(tx)
        .await?;
    Ok(())
}

pub async fn list(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, false, true).await?;
    let mut rules = Vec::new();
    if allowed(&actor) {
        let store = actor.store(&state).await?;
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT data FROM app_interactive_rules WHERE issuer_id=? AND status='active'
             ORDER BY rowid DESC LIMIT 20",
        )
        .bind(&actor.user_id)
        .fetch_all(&store.pool)
        .await?;
        for row in rows {
            rules.push(serde_json::from_str::<Value>(&row).map_err(|_| changed())?);
        }
        actor.authorize_owner(&state).await?;
    }
    Ok(Json(json!({"rules":rules})))
}

pub async fn revoke(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    if !allowed(&actor) {
        return Err(ApiError::new(403, "仅个人空间支持管理已保存的应用权限。"));
    }
    super::policy_data::identifier(&json!(id))?;
    let store = actor.store(&state).await?;
    let mut tx = store.begin().await?;
    actor.authorize_owner(&state).await?;
    let result =
        sqlx::query("UPDATE app_interactive_rules SET status='revoked' WHERE id=? AND issuer_id=?")
            .bind(&id)
            .bind(&actor.user_id)
            .execute(&mut *tx)
            .await?;
    if result.rows_affected() != 1 {
        return Err(ApiError::new(404, "应用授权不存在。"));
    }
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(Json(json!({"ok":true})))
}
