mod workspace_media_support;
mod workspace_support;
use axum::body::Body;
use serde_json::json;
use workspace_media_support::{json as value, png, raw};
use workspace_support::Fixture;
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn source(f: &Fixture) -> serde_json::Value {
    let (status, _, bytes) = raw(
        f,
        "POST",
        &f.path("/bot-avatars/sources"),
        "image/png",
        Body::from(png(20, 20)),
        false,
        Some(&f.owner),
    )
    .await;
    assert_eq!(status, 201, "{}", String::from_utf8_lossy(&bytes));
    value(&bytes)
}
#[tokio::test]
async fn input_byte_and_decoded_pixel_limits_are_enforced_without_persisting_sources() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new().await;
    let (status, _, _) = raw(
        &f,
        "POST",
        &f.path("/bot-avatars/sources"),
        "image/png",
        Body::from(vec![0; 25 * 1024 * 1024]),
        false,
        Some(&f.owner),
    )
    .await;
    assert_eq!(status, 413);
    let mut bytes = png(20, 20);
    bytes[16..20].copy_from_slice(&40_001u32.to_be_bytes());
    bytes[20..24].copy_from_slice(&1000u32.to_be_bytes());
    let crc = crc32(&bytes[12..29]);
    bytes[29..33].copy_from_slice(&crc.to_be_bytes());
    let (status, _, body) = raw(
        &f,
        "POST",
        &f.path("/bot-avatars/sources"),
        "image/png",
        Body::from(bytes),
        false,
        Some(&f.owner),
    )
    .await;
    assert_eq!(status, 413, "{}", String::from_utf8_lossy(&body));
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM avatar_sources")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(source(&f).await["width"], 20);
    f.close().await;
}
#[tokio::test]
async fn final_asset_quota_and_expired_or_deleted_source_do_not_attach_or_insert() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new().await;
    let source = source(&f).await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let crop = json!({"sourceId":source["id"],"crop":{"left":0,"top":0,"size":20}});
    sqlx::query("UPDATE avatar_sources SET expires_at=0")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.request(
            "POST",
            &f.path("/bot-avatars"),
            Some(crop.clone()),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        404
    );
    sqlx::query("UPDATE avatar_sources SET expires_at=?")
        .bind(chrono::Utc::now().timestamp_millis() + 60_000)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<512) INSERT INTO avatar_assets SELECT printf('synthetic-%d',x),'{}',x'524946463030303057454250',0 FROM n").execute(&store.pool).await.unwrap();
    assert_eq!(
        f.request(
            "POST",
            &f.path("/bot-avatars"),
            Some(crop.clone()),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM avatar_assets")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 512);
    sqlx::query("DELETE FROM avatar_sources")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.request(
            "POST",
            &f.path("/bot-avatars"),
            Some(crop),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        404
    );
    f.close().await;
}
fn crc32(input: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in input {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320u32 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}
