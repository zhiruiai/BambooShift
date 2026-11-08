use super::model::Connection;
use crate::{
    error::{ApiError, Result},
    workspace::WorkspaceStore,
};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn initialize(store: &WorkspaceStore) -> Result<()> {
    for table in ["app_connections", "app_actions", "app_oauth_flows"] {
        sqlx::query(&format!(
            "CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY,data TEXT NOT NULL)"
        ))
        .execute(&store.pool)
        .await?;
    }
    super::policy_data::initialize(store).await?;
    super::interactive_rules::initialize(store).await?;
    for mut saved in list_raw(store, "app_connections").await? {
        let old_token = saved.get("token").cloned();
        let old_grant = saved.get("oauth").cloned();
        if old_token.is_some() || old_grant.is_some() {
            let payload = json!({"token":old_token,"grant":old_grant});
            saved["credentialRef"] = json!(
                super::credentials::stage(store, saved["id"].as_str().unwrap_or(""), &payload)
                    .await?
            );
            if let Some(grant) = old_grant {
                saved["authorization"] = json!({"issuer":grant["issuer"],"scopes":grant["scopes"]});
            }
            for key in ["token", "oauth", "credentialGeneration"] {
                saved.as_object_mut().unwrap().remove(key);
            }
            sqlx::query("UPDATE app_connections SET data=json_set(?, '$.tools', json(json_extract(data,'$.tools'))) WHERE id=?")
                .bind(saved.to_string()).bind(saved["id"].as_str()).execute(&store.pool).await?;
        }
        if saved["refreshing"] == true {
            let old = saved["credentialRef"].as_str().map(str::to_owned);
            saved["refreshing"] = json!(false);
            saved["credentialRef"] = Value::Null;
            saved["status"] = json!("needs_auth");
            saved["tools"] = json!([]);
            saved["error"] = json!("上次授权刷新被中断，请重新进行网页登录授权。");
            put_raw(store, "app_connections", &saved).await?;
            super::credentials::remove(store, old.as_deref()).await?;
        }
        if saved["revocation"] == "pending" {
            saved["revocation"] = json!("failed");
            put_raw(store, "app_connections", &saved).await?;
        }
    }
    recover_workflows(store).await
}
pub async fn initialize_attached(store: &WorkspaceStore) -> Result<()> {
    for table in ["app_connections", "app_actions", "app_oauth_flows"] {
        sqlx::query(&format!(
            "CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY,data TEXT NOT NULL)"
        ))
        .execute(&store.pool)
        .await?;
    }
    super::policy_data::initialize(store).await?;
    super::interactive_rules::initialize(store).await?;
    recover_workflows(store).await
}
async fn recover_workflows(store: &WorkspaceStore) -> Result<()> {
    for mut saved in list_raw(store, "app_actions").await? {
        if saved["id"].is_null() {
            saved["id"] = saved["action"]["id"].clone();
        }
        let status = saved["action"]["status"].as_str().unwrap_or("").to_owned();
        if ["pending", "running"].contains(&status.as_str()) {
            super::actions::clear_offer(&mut saved);
            saved["action"]["error"] = json!(if status == "running" {
                super::model::UNKNOWN
            } else {
                "服务已重启，原审批已取消。"
            });
            saved["action"]["status"] = json!(if status == "running" {
                "error"
            } else {
                "cancelled"
            });
            super::actions::persist(store, &saved).await?;
        }
    }
    for mut saved in list_raw(store, "app_oauth_flows").await? {
        if !super::oauth_store::terminal(&saved["flow"]) {
            super::oauth_store::end(
                store,
                &mut saved,
                "cancelled",
                Some("服务已重启，请重新开始授权。"),
            )
            .await?;
        }
    }
    Ok(())
}
pub async fn list_raw(store: &WorkspaceStore, table: &str) -> Result<Vec<Value>> {
    let rows = sqlx::query(&format!("SELECT data FROM {table} ORDER BY rowid"))
        .fetch_all(&store.pool)
        .await?;
    rows.into_iter()
        .map(|r| {
            serde_json::from_str(&r.get::<String, _>("data"))
                .map_err(|_| ApiError::new(409, "应用记录不可用。"))
        })
        .collect()
}
pub async fn get_raw(store: &WorkspaceStore, table: &str, id: &str) -> Result<Value> {
    let data: Option<String> = sqlx::query_scalar(&format!("SELECT data FROM {table} WHERE id=?"))
        .bind(id)
        .fetch_optional(&store.pool)
        .await?;
    serde_json::from_str(&data.ok_or_else(|| ApiError::new(404, "应用记录不存在。"))?)
        .map_err(|_| ApiError::new(409, "应用记录不可用。"))
}
pub async fn put_raw(store: &WorkspaceStore, table: &str, value: &Value) -> Result<()> {
    sqlx::query(&format!(
        "INSERT INTO {table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data"
    ))
    .bind(
        value["id"]
            .as_str()
            .ok_or_else(|| ApiError::bad("应用记录无效。"))?,
    )
    .bind(value.to_string())
    .execute(&store.pool)
    .await?;
    store.emit("update", json!({}));
    Ok(())
}
pub async fn connection(store: &WorkspaceStore, id: &str) -> Result<Connection> {
    serde_json::from_value(get_raw(store, "app_connections", id).await?)
        .map_err(|_| ApiError::new(409, "应用记录不可用。"))
}
pub(crate) async fn connection_in(
    tx: &mut sqlx::SqliteConnection,
    id: &str,
) -> Result<Option<Connection>> {
    let data: Option<String> = sqlx::query_scalar("SELECT data FROM app_connections WHERE id=?")
        .bind(id)
        .fetch_optional(tx)
        .await?;
    data.map(|raw| serde_json::from_str(&raw).map_err(|_| ApiError::new(409, "应用记录不可用。")))
        .transpose()
}
pub async fn save(store: &WorkspaceStore, value: &Connection) -> Result<()> {
    let mut record = serde_json::to_value(value).unwrap();
    if value.credential_ref.is_none() {
        if let Some(token) = &value.legacy_token {
            record["token"] = json!(token);
        }
        if let Some(grant) = &value.legacy_grant {
            record["oauth"] = grant.clone();
        }
    }
    let previous = get_raw(store, "app_connections", &value.id).await.ok();
    if previous
        .as_ref()
        .is_some_and(|v| v["revision"] == value.revision && v["tools"] == record["tools"])
    {
        sqlx::query("UPDATE app_connections SET data=json_set(?, '$.tools', json(json_extract(data,'$.tools'))) WHERE id=?")
            .bind(record.to_string()).bind(&value.id).execute(&store.pool).await?;
        store.emit("update", json!({}));
        Ok(())
    } else {
        put_raw(store, "app_connections", &record).await
    }
}

pub async fn save_changed(
    state: &crate::db::State,
    store: &WorkspaceStore,
    value: &Connection,
) -> Result<()> {
    save(store, value).await?;
    state.changed(None, None, None);
    state.workspace.emit_all("update", json!({})).await;
    Ok(())
}
