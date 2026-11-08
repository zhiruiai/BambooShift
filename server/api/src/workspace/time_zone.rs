use super::access;
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

pub const DEFAULT_TIME_ZONE: &str = "Asia/Shanghai";
pub fn normalize(value: &Value) -> Result<String> {
    let text = value
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 100
                && s.as_bytes()[0].is_ascii_alphabetic()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/_+-.".contains(&b))
        })
        .ok_or_else(|| ApiError::bad("请选择有效的 IANA 时区。"))?;
    let zone = chrono_tz::TZ_VARIANTS
        .iter()
        .find(|zone| zone.name().eq_ignore_ascii_case(text))
        .ok_or_else(|| ApiError::bad("请选择有效的 IANA 时区。"))?;
    let canonical = super::time_zone_links::canonical(zone.name());
    Ok(canonical.to_owned())
}
pub fn effective(value: Option<&Value>) -> Result<String> {
    match value {
        None => Ok(DEFAULT_TIME_ZONE.to_owned()),
        Some(v) => normalize(v),
    }
}
fn zone(value: Option<&Value>) -> Result<Tz> {
    effective(value)?
        .parse()
        .map_err(|_| ApiError::bad("计划时区无效。"))
}
pub fn local_day(at: i64, value: Option<&Value>) -> Result<NaiveDate> {
    let instant = DateTime::<Utc>::from_timestamp_millis(at)
        .ok_or_else(|| ApiError::bad("计划时间无效。"))?;
    Ok(instant.with_timezone(&zone(value)?).date_naive())
}
pub fn time(value: &str) -> Result<NaiveTime> {
    if value.len() != 5
        || value.as_bytes()[2] != b':'
        || !value[..2]
            .bytes()
            .chain(value[3..].bytes())
            .all(|b| b.is_ascii_digit())
    {
        return Err(ApiError::bad("执行时间无效。"));
    }
    NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| ApiError::bad("执行时间无效。"))
}
pub fn slot(day: NaiveDate, clock: &str, value: Option<&Value>) -> Result<Option<i64>> {
    let at = day.and_time(time(clock)?);
    Ok(match zone(value)?.from_local_datetime(&at) {
        LocalResult::None => None,
        LocalResult::Single(at) => Some(at.timestamp_millis()),
        LocalResult::Ambiguous(a, b) => Some(a.timestamp_millis().min(b.timestamp_millis())),
    })
}
#[derive(Clone, Debug)]
pub enum Schedule {
    Interval(u32),
    Daily(String),
    Weekly(Vec<u32>, String),
}
pub fn parse(schedule: &str) -> Result<Schedule> {
    if schedule.len() > 80 {
        return Err(ApiError::bad("执行频率无效。"));
    }
    if let Some(minutes) = schedule.strip_prefix("interval:") {
        if minutes.is_empty() || !minutes.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ApiError::bad("执行间隔无效。"));
        }
        let n = minutes
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0 && *n <= 525600)
            .ok_or_else(|| ApiError::bad("执行间隔无效。"))?;
        return Ok(Schedule::Interval(n));
    }
    if let Some(clock) = schedule.strip_prefix("daily:") {
        time(clock)?;
        return Ok(Schedule::Daily(clock.to_owned()));
    }
    if let Some(rest) = schedule.strip_prefix("weekly:") {
        if let Some((days, clock)) = rest.split_once(':') {
            time(clock)?;
            let mut selected = Vec::new();
            for d in days.split(',') {
                if d.len() != 1 {
                    return Err(ApiError::bad("请选择有效的每周执行日期。"));
                }
                let d = d
                    .parse::<u32>()
                    .ok()
                    .filter(|n| (1..=7).contains(n))
                    .ok_or_else(|| ApiError::bad("请选择有效的每周执行日期。"))?;
                if selected.contains(&d) {
                    return Err(ApiError::bad("每周执行日期不能重复。"));
                }
                selected.push(d);
            }
            selected.sort();
            return Ok(Schedule::Weekly(selected, clock.to_owned()));
        }
    }
    Err(ApiError::bad("请选择有效的执行频率。"))
}
pub fn normalize_schedule(schedule: &str) -> Result<String> {
    Ok(match parse(schedule)? {
        Schedule::Interval(n) => format!("interval:{n}"),
        Schedule::Daily(clock) => format!("daily:{clock}"),
        Schedule::Weekly(days, clock) => format!(
            "weekly:{}:{clock}",
            days.iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
    })
}
pub fn next(schedule: &str, from: i64, value: Option<&Value>) -> Result<String> {
    let schedule = parse(schedule)?;
    zone(value)?;
    DateTime::<Utc>::from_timestamp_millis(from)
        .ok_or_else(|| ApiError::bad("计划时间超出范围。"))?;
    if let Schedule::Interval(n) = schedule {
        return Ok(iso(from
            .checked_add(i64::from(n) * 60000)
            .ok_or_else(|| ApiError::bad("计划时间超出范围。"))?));
    }
    let day = local_day(from, value)?;
    for offset in 0..=14 {
        let Some(date) = day.checked_add_signed(Duration::days(offset)) else {
            break;
        };
        let clock = match &schedule {
            Schedule::Daily(clock) => clock,
            Schedule::Weekly(days, clock)
                if days.contains(&date.weekday().number_from_monday()) =>
            {
                clock
            }
            _ => continue,
        };
        if let Some(at) = slot(date, clock, value)? {
            if at > from {
                return Ok(iso(at));
            }
        }
    }
    Err(ApiError::bad("无法计算下一次执行时间。"))
}
pub async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS workspace_time_zone(id TEXT PRIMARY KEY CHECK(id='default'),data TEXT NOT NULL)").execute(conn).await?;
    Ok(())
}
pub async fn read(conn: &mut SqliteConnection) -> Result<Value> {
    if let Some(row) = sqlx::query("SELECT data FROM workspace_time_zone WHERE id='default'")
        .fetch_optional(conn)
        .await?
    {
        let mut value: Value = serde_json::from_str(row.get("data"))
            .map_err(|_| ApiError::new(503, "空间时区设置暂不可用。"))?;
        value["timeZone"] = json!(normalize(&value["timeZone"])?);
        if !value["revision"]
            .as_str()
            .is_some_and(|r| uuid::Uuid::parse_str(r).is_ok())
        {
            return Err(ApiError::new(503, "空间时区版本无效。"));
        }
        Ok(value)
    } else {
        Ok(json!({"timeZone":DEFAULT_TIME_ZONE,"revision":"unset"}))
    }
}
pub async fn get(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let value = read(&mut *store.pool.acquire().await?).await?;
    grant.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn put(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    crate::error::only_fields(&body, &["expectedRevision", "timeZone"])?;
    let desired = normalize(&body["timeZone"])?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let current = read(&mut tx).await?;
    if current["revision"] != body["expectedRevision"] {
        return Err(ApiError::new(409, "空间时区已变化，请重新载入。"));
    }
    let changed = current["timeZone"] != desired;
    let value = if changed {
        let next = json!({"timeZone":desired,"revision":uuid::Uuid::new_v4().to_string(),"updatedAt":iso(now())});
        sqlx::query("INSERT INTO workspace_time_zone(id,data) VALUES('default',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(next.to_string()).execute(&mut *tx).await?;
        next
    } else {
        current
    };
    grant.authorize(&state).await?;
    tx.commit().await?;
    if changed {
        store.emit("update", json!({}));
    }
    grant.authorize(&state).await?;
    Ok(Json(value))
}
