use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

fn delivered(data: &str) -> String {
    format!(
        "json_extract({data},'$.role')='assistant' AND coalesce(json_extract({data},'$.kind'),'')<>'web_research' AND json_extract({data},'$.status') IN ('done','error') AND json_extract({data},'$.metadata.delegation') IS NULL AND coalesce(json_extract({data},'$.metadata.internal'),0)<>1"
    )
}

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS unread_deliveries(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS unread_conversation ON unread_deliveries(conversation_id,sequence)",
        "CREATE TABLE IF NOT EXISTS conversation_reads(actor_id TEXT NOT NULL,conversation_id TEXT NOT NULL,through_sequence INTEGER NOT NULL,PRIMARY KEY(actor_id,conversation_id))",
        "CREATE TABLE IF NOT EXISTS unread_baselines(conversation_id TEXT PRIMARY KEY,through_sequence INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS unread_schema(version INTEGER PRIMARY KEY)",
    ] {
        sqlx::query(sql).execute(&mut *conn).await?;
    }
    if sqlx::query_scalar::<_, i64>("SELECT version FROM unread_schema WHERE version=1")
        .fetch_optional(&mut *conn)
        .await?
        .is_none()
    {
        // Existing history is a baseline, not a new delivery. Preserve the former
        // template-only count for each actor until that actor reads the conversation.
        sqlx::query(&format!("INSERT OR IGNORE INTO unread_deliveries(message_id,conversation_id) SELECT id,json_extract(data,'$.conversationId') FROM messages WHERE {} AND json_type(data,'$.conversationId')='text' ORDER BY rowid", delivered("data"))).execute(&mut *conn).await?;
        let chats = sqlx::query("SELECT id,data FROM conversations")
            .fetch_all(&mut *conn)
            .await?;
        for chat in chats {
            let id: String = chat.get("id");
            let value: Value = serde_json::from_str(chat.get("data"))
                .map_err(|_| ApiError::new(409, "会话数据暂不可用。"))?;
            let legacy = value["unread"].as_u64().unwrap_or(0).min(i64::MAX as u64) as i64;
            let baseline = sqlx::query_scalar::<_, i64>("SELECT coalesce(max(sequence),0) FROM (SELECT sequence FROM unread_deliveries WHERE conversation_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)").bind(&id).bind(legacy).fetch_one(&mut *conn).await?;
            sqlx::query("INSERT INTO unread_baselines(conversation_id,through_sequence) VALUES(?,?) ON CONFLICT DO NOTHING").bind(id).bind(baseline).execute(&mut *conn).await?;
        }
        sqlx::query("INSERT INTO unread_schema(version) VALUES(1)")
            .execute(&mut *conn)
            .await?;
    }
    for (name, event) in [("insert", "INSERT"), ("update", "UPDATE OF data")] {
        // Refresh existing installations when delivery eligibility changes.
        sqlx::query(&format!("DROP TRIGGER IF EXISTS unread_message_{name}"))
            .execute(&mut *conn)
            .await?;
        sqlx::query(&format!("CREATE TRIGGER IF NOT EXISTS unread_message_{name} AFTER {event} ON messages WHEN {} AND json_type(NEW.data,'$.conversationId')='text' AND NOT EXISTS(SELECT 1 FROM unread_deliveries WHERE message_id=NEW.id) BEGIN INSERT INTO unread_deliveries(message_id,conversation_id) VALUES(NEW.id,json_extract(NEW.data,'$.conversationId')); END", delivered("NEW.data"))).execute(&mut *conn).await?;
    }
    sqlx::query("CREATE TRIGGER IF NOT EXISTS unread_conversation_delete AFTER DELETE ON conversations BEGIN DELETE FROM unread_deliveries WHERE conversation_id=OLD.id; DELETE FROM conversation_reads WHERE conversation_id=OLD.id; DELETE FROM unread_baselines WHERE conversation_id=OLD.id; END").execute(&mut *conn).await?;
    Ok(())
}

pub(super) async fn project(
    conn: &mut SqliteConnection,
    actor: &str,
    chats: &mut [Value],
) -> Result<()> {
    let rows = sqlx::query(&format!("SELECT d.conversation_id,max(d.sequence) AS latest,sum(CASE WHEN m.id IS NOT NULL AND {} AND d.sequence>coalesce(r.through_sequence,b.through_sequence,0) THEN 1 ELSE 0 END) AS unread FROM unread_deliveries d LEFT JOIN messages m ON m.id=d.message_id LEFT JOIN conversation_reads r ON r.conversation_id=d.conversation_id AND r.actor_id=? LEFT JOIN unread_baselines b ON b.conversation_id=d.conversation_id GROUP BY d.conversation_id", delivered("m.data"))).bind(actor).fetch_all(&mut *conn).await?;
    let values = rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("conversation_id"),
                (row.get::<i64, _>("latest"), row.get::<i64, _>("unread")),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    for chat in chats {
        let (latest, unread) = values
            .get(chat["id"].as_str().unwrap_or(""))
            .copied()
            .unwrap_or_default();
        chat["unread"] = json!(unread);
        chat["readThrough"] = json!(latest);
    }
    Ok(())
}

pub(super) async fn acknowledge(
    conn: &mut SqliteConnection,
    actor: &str,
    conversation: &str,
    through: Option<&Value>,
) -> Result<bool> {
    let latest: i64 = sqlx::query_scalar(
        "SELECT coalesce(max(sequence),0) FROM unread_deliveries WHERE conversation_id=?",
    )
    .bind(conversation)
    .fetch_one(&mut *conn)
    .await?;
    let through = match through {
        None => latest,
        Some(value) => value
            .as_i64()
            .filter(|n| *n >= 0 && *n <= latest)
            .ok_or_else(|| ApiError::bad("已读位置无效，请刷新会话。"))?,
    };
    let previous: i64 = sqlx::query_scalar("SELECT coalesce((SELECT through_sequence FROM conversation_reads WHERE actor_id=? AND conversation_id=?),(SELECT through_sequence FROM unread_baselines WHERE conversation_id=?),0)").bind(actor).bind(conversation).bind(conversation).fetch_one(&mut *conn).await?;
    if through <= previous {
        return Ok(false);
    }
    sqlx::query("INSERT INTO conversation_reads(actor_id,conversation_id,through_sequence) VALUES(?,?,?) ON CONFLICT(actor_id,conversation_id) DO UPDATE SET through_sequence=max(through_sequence,excluded.through_sequence)").bind(actor).bind(conversation).bind(through).execute(&mut *conn).await?;
    Ok(true)
}

#[cfg(test)]
mod tests;
