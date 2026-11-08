use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, State as Extract},
    http::HeaderMap,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS model_usage(run_id TEXT NOT NULL,message_id TEXT NOT NULL,created_at INTEGER NOT NULL,user_id TEXT NOT NULL,agent_id TEXT,provider TEXT NOT NULL,model TEXT NOT NULL,profile_id TEXT NOT NULL,reported INTEGER NOT NULL CHECK(reported IN(0,1)),input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,total_tokens INTEGER NOT NULL,PRIMARY KEY(run_id,message_id))").execute(&mut *conn).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS model_usage_period ON model_usage(created_at,user_id)")
        .execute(conn)
        .await?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Period {
    days: Option<u16>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    model_turns: u64,
    reported_turns: u64,
    unreported_turns: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    total_tokens: u64,
}
impl Totals {
    fn add(&mut self, row: &sqlx::sqlite::SqliteRow) {
        self.model_turns += row.get::<i64, _>("turns") as u64;
        self.reported_turns += row.get::<i64, _>("reported") as u64;
        self.unreported_turns = self.model_turns - self.reported_turns;
        self.input_tokens += row.get::<i64, _>("input") as u64;
        self.output_tokens += row.get::<i64, _>("output") as u64;
        self.cache_read_tokens += row.get::<i64, _>("cache_read") as u64;
        self.cache_write_tokens += row.get::<i64, _>("cache_write") as u64;
        self.total_tokens += row.get::<i64, _>("total") as u64;
    }
}
pub async fn get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Query(period): Query<Period>,
) -> Result<Json<Value>> {
    let grant = super::access::require(&state, &headers, &wid, false, true).await?;
    let days = period.days.unwrap_or(30);
    if ![7, 30, 90].contains(&days) {
        return Err(ApiError::bad("请选择 7、30 或 90 天的用量窗口。"));
    }
    let store = grant.store(&state).await?;
    let until = now();
    let since = (DateTime::<Utc>::from_timestamp_millis(until)
        .unwrap()
        .date_naive()
        - Duration::days(i64::from(days) - 1))
    .and_hms_opt(0, 0, 0)
    .unwrap()
    .and_utc()
    .timestamp_millis();
    let mut tx = store.pool.begin().await?;
    let rows = sqlx::query("SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch') AS day,agent_id,provider,model,COUNT(*) AS turns,SUM(reported) AS reported,SUM(input_tokens) AS input,SUM(output_tokens) AS output,SUM(cache_read_tokens) AS cache_read,SUM(cache_write_tokens) AS cache_write,SUM(total_tokens) AS total FROM model_usage WHERE created_at>=? AND created_at<=? AND (? OR user_id=?) GROUP BY day,agent_id,provider,model ORDER BY day DESC,agent_id,provider,model")
        .bind(since).bind(until).bind(grant.is_owner).bind(&grant.user_id).fetch_all(&mut *tx).await?;
    let agents = super::WorkspaceStore::list_in(&mut tx, super::Table::Agents).await?;
    let mut totals = Totals::default();
    let mut by_day = BTreeMap::<String, Totals>::new();
    let mut by_bot = BTreeMap::<Option<String>, Totals>::new();
    let mut by_model = BTreeMap::<(String, String), Totals>::new();
    for row in rows {
        totals.add(&row);
        by_day.entry(row.get("day")).or_default().add(&row);
        by_bot.entry(row.get("agent_id")).or_default().add(&row);
        by_model
            .entry((row.get("provider"), row.get("model")))
            .or_default()
            .add(&row);
    }
    tx.commit().await?;
    grant.authorize(&state).await?;
    // Recheck owner status: a downgraded owner must never receive workspace-wide totals.
    if grant.is_owner {
        grant.authorize_owner(&state).await?;
    }
    Ok(Json(json!({
        "scope":{"workspaceId":wid,"userId":grant.user_id,"visibility":if grant.is_owner {"workspace"} else {"self"}},
        "period":{"days":days,"since":iso(since),"until":iso(until),"timeZone":"UTC"},
        "totals":totals,
        "byDay":by_day.into_iter().rev().map(|(day,totals)|json!({"day":day,"totals":totals})).collect::<Vec<_>>(),
        "byBot":by_bot.into_iter().map(|(id,totals)|{let name=id.as_deref().and_then(|id|agents.iter().find(|a|a["id"]==id)).and_then(|a|a["name"].as_str());json!({"agentId":id,"name":name,"totals":totals})}).collect::<Vec<_>>(),
        "byModel":by_model.into_iter().map(|((provider,model),totals)|json!({"provider":provider,"model":model,"totals":totals})).collect::<Vec<_>>(),
        "cost":null
    })))
}
