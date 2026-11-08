use super::{authority::ExecutionAccess, registry::ActiveRun};
use crate::{db::now, error::Result};
use serde_json::Value;
use sqlx::SqliteConnection;

/// Persist only provider-reported counters; catalog prices never establish a charge.
pub(super) async fn record(
    conn: &mut SqliteConnection,
    grant: &ExecutionAccess,
    active: &ActiveRun,
    result: &Value,
    event: &Value,
) -> Result<()> {
    let profile = active.family.model_profile.get().unwrap_or(&Value::Null);
    record_snapshot(
        conn,
        &active.run_id,
        result["id"].as_str().unwrap_or(""),
        grant.user_id(),
        Some(&active.agent_id),
        profile,
        &event["message"]["usage"],
    )
    .await
}

pub(super) async fn record_snapshot(
    conn: &mut SqliteConnection,
    run_id: &str,
    message_id: &str,
    user_id: &str,
    agent_id: Option<&str>,
    profile: &Value,
    usage: &Value,
) -> Result<()> {
    let values = counters(usage);
    sqlx::query("INSERT OR IGNORE INTO model_usage(run_id,message_id,created_at,user_id,agent_id,provider,model,profile_id,reported,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(run_id).bind(message_id)
        .bind(now()).bind(user_id).bind(agent_id)
        .bind(profile["provider"].as_str().unwrap_or(""))
        .bind(profile["model"].as_str().unwrap_or(""))
        .bind(profile["profileId"].as_str().unwrap_or(""))
        .bind(values.iter().any(|value| *value > 0))
        .bind(values[0]).bind(values[1]).bind(values[2]).bind(values[3]).bind(values[4])
        .execute(conn).await?;
    Ok(())
}

fn counters(usage: &Value) -> [i64; 5] {
    let mut result = [0; 5];
    for (index, field) in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]
        .iter()
        .enumerate()
    {
        if let Some(value) = usage.get(field) {
            let Some(value) = value.as_u64().filter(|value| *value <= 1_000_000_000) else {
                return [0; 5];
            };
            result[index] = value as i64;
        }
    }
    result
}
