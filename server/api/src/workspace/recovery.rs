use super::{Table, WorkspaceStore};
use crate::{
    db::{iso, now},
    error::{ApiError, Result},
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::HashSet;
const INTERRUPTED: &str = "服务已重新启动，此次任务未确认完成，请重新发送。";

/** Reconciliation never invokes a model, restores an approval, or replays a queue. */
pub async fn recover(conn: &mut SqliteConnection) -> Result<()> {
    let messages = WorkspaceStore::list_in(conn, Table::Messages).await?;
    let unfinished: HashSet<String> = messages
        .iter()
        .filter(|m| m["status"] == "running")
        .filter_map(|m| m["metadata"]["inputMessageId"].as_str().map(str::to_owned))
        .collect();
    for mut message in messages {
        let mut changed = false;
        if message.get("mentions").is_some() {
            changed = crate::agent::mentions::recover(&mut message, INTERRUPTED);
        } else if message["delivery"]["state"] == "queued"
            || (message["delivery"]["state"] == "delivered"
                && message["id"]
                    .as_str()
                    .is_some_and(|id| unfinished.contains(id)))
        {
            message["delivery"]["state"] = json!("interrupted");
            message["delivery"]["reason"] = json!(INTERRUPTED);
            changed = true;
        }
        if message["status"] == "running" {
            message["status"] = json!("error");
            let content = message["content"].as_str().unwrap_or("");
            message["content"] = json!(if content.is_empty() {
                INTERRUPTED.to_owned()
            } else {
                format!("{content}\n\n{INTERRUPTED}")
            });
            changed = true;
        }
        if let Some(action) = message
            .get_mut("metadata")
            .and_then(|m| m.get_mut("appAction"))
        {
            if ["pending", "running"]
                .iter()
                .any(|status| action["status"] == *status)
            {
                let started = action["status"] == "running";
                action["status"] = json!(if started { "error" } else { "cancelled" });
                action["error"] = json!(if started {
                    "服务重启，外部操作结果未知；不会自动重试。"
                } else {
                    "服务重启，原审批已失效。"
                });
                changed = true;
            }
        }
        if changed {
            WorkspaceStore::put_in(conn, Table::Messages, &message).await?;
        }
    }
    for mut agent in WorkspaceStore::list_in(conn, Table::Agents).await? {
        if agent["status"] == "working" || agent["status"] == "waiting" {
            agent["status"] = json!("idle");
            WorkspaceStore::put_in(conn, Table::Agents, &agent).await?;
        }
    }
    for (table, status_field, waiting) in [
        ("routine_runs", "status", "running"),
        ("routine_operations", "status", "submitted"),
        ("primary_check_ins", "status", "running"),
    ] {
        if sqlx::query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .bind(table)
            .fetch_optional(&mut *conn)
            .await?
            .is_none()
        {
            continue;
        }
        let rows = sqlx::query(&format!("SELECT rowid,data FROM {table}"))
            .fetch_all(&mut *conn)
            .await?;
        for row in rows {
            let mut value: Value = serde_json::from_str(row.get("data"))
                .map_err(|_| ApiError::new(409, "运行记录暂不可用。"))?;
            if value[status_field] == waiting {
                value[status_field] = json!("interrupted");
                value["finishedAt"] = json!(iso(now()));
                if table == "primary_check_ins" {
                    value["reason"] = json!(INTERRUPTED);
                } else {
                    value["error"] = json!(INTERRUPTED);
                }
                sqlx::query(&format!("UPDATE {table} SET data=? WHERE rowid=?"))
                    .bind(value.to_string())
                    .bind(row.get::<i64, _>("rowid"))
                    .execute(&mut *conn)
                    .await?;
            }
        }
    }
    Ok(())
}
