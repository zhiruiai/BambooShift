use crate::{
    error::{ApiError, Result},
    password,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::SqliteConnection;
use subtle::ConstantTimeEq;

const RECEIPT_LIFETIME: i64 = 24 * 60 * 60 * 1_000;
const RATE_WINDOW: i64 = 60_000;
const RATE_LIMIT: i64 = 10;

#[derive(sqlx::FromRow)]
pub(super) struct Key {
    pub issuer_id: String,
    pub revision: String,
    pub key_digest: Option<String>,
    pub target_generation: String,
}

pub(super) async fn initialize(conn: &mut SqliteConnection) -> Result<()> {
    for query in [
        "CREATE TABLE IF NOT EXISTS routine_webhook_generations (
            routine_id TEXT PRIMARY KEY, generation TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS routine_webhook_deliveries (
            run_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, key_revision TEXT NOT NULL,
            idempotency_digest TEXT, payload_digest TEXT NOT NULL, admitted_at INTEGER NOT NULL,
            UNIQUE(routine_id,key_revision,idempotency_digest))",
        "CREATE INDEX IF NOT EXISTS routine_webhook_deliveries_rate
            ON routine_webhook_deliveries(routine_id,admitted_at)",
        "CREATE INDEX IF NOT EXISTS routine_webhook_deliveries_expiry
            ON routine_webhook_deliveries(admitted_at)",
        "CREATE TRIGGER IF NOT EXISTS routine_webhook_routine_created AFTER INSERT ON routines BEGIN
            INSERT INTO routine_webhook_generations VALUES(new.id,lower(hex(randomblob(16))))
            ON CONFLICT(routine_id) DO UPDATE SET generation=excluded.generation;
        END",
        "CREATE TRIGGER IF NOT EXISTS routine_webhook_target_changed AFTER UPDATE ON routines
            WHEN json_extract(old.data,'$.agentId') IS NOT json_extract(new.data,'$.agentId') OR
                 json_extract(old.data,'$.conversationId') IS NOT json_extract(new.data,'$.conversationId')
            BEGIN
                INSERT INTO routine_webhook_generations VALUES(old.id,lower(hex(randomblob(16))))
                ON CONFLICT(routine_id) DO UPDATE SET generation=excluded.generation;
            END",
        "CREATE TRIGGER IF NOT EXISTS routine_webhook_routine_removed AFTER DELETE ON routines BEGIN
            DELETE FROM routine_webhook_generations WHERE routine_id=old.id;
            DELETE FROM routine_webhook_deliveries WHERE routine_id=old.id;
        END",
    ] {
        sqlx::query(query).execute(&mut *conn).await?;
    }
    Ok(())
}

pub(super) async fn generation(conn: &mut SqliteConnection, routine: &str) -> Result<String> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT generation FROM routine_webhook_generations WHERE routine_id=?")
            .bind(routine)
            .fetch_optional(conn)
            .await?;
    Ok(value.unwrap_or_else(|| "unset".into()))
}

pub(super) async fn read(
    conn: &mut SqliteConnection,
    wid: &str,
    routine: &str,
) -> Result<Option<Key>> {
    Ok(sqlx::query_as(
        "SELECT issuer_id,revision,key_digest,target_generation FROM routine_webhook_keys
         WHERE workspace_id=? AND routine_id=?",
    )
    .bind(wid)
    .bind(routine)
    .fetch_optional(conn)
    .await?)
}

pub(super) async fn save(
    conn: &mut SqliteConnection,
    wid: &str,
    routine: &str,
    key: &Key,
) -> Result<()> {
    sqlx::query("INSERT INTO routine_webhook_keys VALUES(?,?,?,?,?,?)
        ON CONFLICT(workspace_id,routine_id) DO UPDATE SET issuer_id=excluded.issuer_id,
        revision=excluded.revision,key_digest=excluded.key_digest,target_generation=excluded.target_generation")
        .bind(wid).bind(routine).bind(&key.issuer_id).bind(&key.revision).bind(&key.key_digest)
        .bind(&key.target_generation).execute(conn).await?;
    Ok(())
}

pub(super) async fn authenticate(
    conn: &mut SqliteConnection,
    wid: &str,
    routine: &str,
    token: &str,
) -> Result<Key> {
    let key: Option<Key> = sqlx::query_as(
        "SELECT k.issuer_id,k.revision,k.key_digest,k.target_generation FROM routine_webhook_keys k
         JOIN workspaces w ON w.id=k.workspace_id AND w.status='active'
         JOIN memberships m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_id AND m.role='owner'
         JOIN users u ON u.id=k.issuer_id AND u.status='active'
         WHERE k.workspace_id=? AND k.routine_id=? AND k.key_digest IS NOT NULL",
    )
    .bind(wid)
    .bind(routine)
    .fetch_optional(conn)
    .await?;
    let submitted = password::digest(token);
    key.filter(|key| {
        key.key_digest
            .as_ref()
            .is_some_and(|hash| bool::from(hash.as_bytes().ct_eq(submitted.as_bytes())))
    })
    .ok_or_else(super::webhooks::unauthorized)
}

pub(super) struct Delivery {
    idempotency_digest: Option<String>,
    payload_digest: String,
}

impl Delivery {
    pub(super) fn new(token: &str, idempotency: Option<&str>, payload: &[u8]) -> Self {
        let digest = |scope: &[u8], bytes: &[u8]| {
            let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("Valid HMAC key");
            mac.update(scope);
            mac.update(bytes);
            hex::encode(mac.finalize().into_bytes())
        };
        Self {
            idempotency_digest: idempotency.map(|id| digest(b"idempotency\0", id.as_bytes())),
            payload_digest: digest(b"payload\0", payload),
        }
    }

    pub(super) async fn previous(
        &self,
        conn: &mut SqliteConnection,
        routine: &str,
        revision: &str,
        at: i64,
    ) -> Result<Option<String>> {
        let Some(idempotency) = &self.idempotency_digest else {
            return Ok(None);
        };
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT run_id,payload_digest FROM routine_webhook_deliveries
             WHERE routine_id=? AND key_revision=? AND idempotency_digest=? AND admitted_at>?",
        )
        .bind(routine)
        .bind(revision)
        .bind(idempotency)
        .bind(at - RECEIPT_LIFETIME)
        .fetch_optional(conn)
        .await?;
        match row {
            Some((run_id, digest)) if digest == self.payload_digest => Ok(Some(run_id)),
            Some(_) => Err(ApiError::new(409, "此 Webhook 投递标识已用于其他内容。")
                .with_code("ROUTINE_WEBHOOK_DUPLICATE_MISMATCH")),
            None => Ok(None),
        }
    }

    pub(super) async fn insert(
        &self,
        conn: &mut SqliteConnection,
        routine: &str,
        revision: &str,
        run: &str,
        at: i64,
    ) -> Result<()> {
        sqlx::query("DELETE FROM routine_webhook_deliveries WHERE admitted_at<=?")
            .bind(at - RECEIPT_LIFETIME)
            .execute(&mut *conn)
            .await?;
        sqlx::query("INSERT INTO routine_webhook_deliveries VALUES(?,?,?,?,?,?)")
            .bind(run)
            .bind(routine)
            .bind(revision)
            .bind(&self.idempotency_digest)
            .bind(&self.payload_digest)
            .bind(at)
            .execute(conn)
            .await?;
        Ok(())
    }
}

pub(super) async fn check_rate(conn: &mut SqliteConnection, routine: &str, at: i64) -> Result<()> {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM routine_webhook_deliveries WHERE routine_id=? AND admitted_at>?",
    )
    .bind(routine)
    .bind(at - RATE_WINDOW)
    .fetch_one(conn)
    .await?;
    if count >= RATE_LIMIT {
        return Err(ApiError::new(429, "此例行任务的 Webhook 投递过于频繁。")
            .with_code("ROUTINE_WEBHOOK_RATE_LIMIT"));
    }
    Ok(())
}
