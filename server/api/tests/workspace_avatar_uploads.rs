mod workspace_media_support;
mod workspace_support;
use axum::body::Body;
use image::{GenericImageView, ImageDecoder, ImageReader};
use serde_json::json;
use std::{io::Cursor, sync::Arc, time::Duration};
use workspace_media_support::{json as value, png, raw};
use workspace_support::Fixture;
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn stage(f: &Fixture, bytes: Vec<u8>, mime: &str) -> (u16, serde_json::Value) {
    let (status, _, bytes) = raw(
        f,
        "POST",
        &f.path("/bot-avatars/sources"),
        mime,
        Body::from(bytes),
        false,
        Some(&f.owner),
    )
    .await;
    (status, value(&bytes))
}
#[tokio::test]
async fn real_process_crops_original_pixels_preserves_alpha_and_publishes_only_on_save() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let (status, source) = stage(&f, png(120, 60), "image/png").await;
    assert_eq!(status, 201, "{source}");
    assert_eq!(source["width"], 120);
    assert_eq!(source["height"], 60);
    let sourcepath = f.path(&format!(
        "/bot-avatars/sources/{}",
        source["id"].as_str().unwrap()
    ));
    let (status, headers, preview) = raw(
        &f,
        "GET",
        &sourcepath,
        "",
        Body::empty(),
        false,
        Some(&f.owner),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(headers["content-type"], "image/webp");
    assert_eq!(
        image::load_from_memory(&preview).unwrap().dimensions(),
        (120, 60)
    );
    assert_eq!(
        raw(
            &f,
            "GET",
            &sourcepath,
            "",
            Body::empty(),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    let (status, asset) = f
        .request(
            "POST",
            &f.path("/bot-avatars"),
            Some(json!({"sourceId":source["id"],"crop":{"left":60,"top":0,"size":60}})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{asset}");
    let path = f.path(&format!("/bot-avatars/{}", asset["id"].as_str().unwrap()));
    let (status, _, bytes) = raw(&f, "GET", &path, "", Body::empty(), false, Some(&f.owner)).await;
    assert_eq!(status, 200);
    let output = image::load_from_memory(&bytes).unwrap();
    assert_eq!(output.dimensions(), (512, 512));
    let pixel = output.get_pixel(256, 256);
    assert!(pixel[2] > 200 && pixel[0] < 50);
    assert_eq!(pixel[3], 80);
    assert_eq!(
        raw(&f, "GET", &path, "", Body::empty(), true, Some(&f.member))
            .await
            .0,
        403
    );
    let bot = &boot["agents"][0];
    let (status, saved) = f
        .request(
            "PATCH",
            &f.path(&format!("/agents/{}", bot["id"].as_str().unwrap())),
            Some(json!({"expectedRevision":bot["configRevision"],"avatarImageId":asset["id"]})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(
        raw(&f, "GET", &path, "", Body::empty(), true, Some(&f.member))
            .await
            .2,
        bytes
    );
    assert_eq!(
        raw(&f, "GET", &path, "", Body::empty(), true, Some(&f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        f.request("DELETE", &sourcepath, None, false, Some(&f.owner))
            .await
            .0,
        204
    );
    assert_eq!(
        raw(
            &f,
            "GET",
            &sourcepath,
            "",
            Body::empty(),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        404
    );
    assert_eq!(
        raw(&f, "GET", &path, "", Body::empty(), true, Some(&f.member))
            .await
            .2,
        bytes
    );
    f.close().await;
}
#[tokio::test]
async fn jpeg_exif_orientation_changes_crop_coordinates_and_metadata_is_removed() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new().await;
    let image = image::load_from_memory(&png(80, 40)).unwrap().to_rgb8();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode_image(&image)
        .unwrap();
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = vec![255, 216, 255, 225];
    oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend_from_slice(exif);
    oriented.extend_from_slice(&jpeg[2..]);
    let (status, source) = stage(&f, oriented, "image/jpeg").await;
    assert_eq!(status, 201, "{source}");
    assert_eq!(source["width"], 40);
    assert_eq!(source["height"], 80);
    let (status, asset) = f
        .request(
            "POST",
            &f.path("/bot-avatars"),
            Some(json!({"sourceId":source["id"],"crop":{"left":0,"top":0,"size":40}})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201, "{asset}");
    let path = f.path(&format!("/bot-avatars/{}", asset["id"].as_str().unwrap()));
    let (_, _, bytes) = raw(&f, "GET", &path, "", Body::empty(), false, Some(&f.owner)).await;
    let mut decoder = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .unwrap()
        .into_decoder()
        .unwrap();
    assert!(decoder.exif_metadata().unwrap().is_none());
    drop(decoder);
    let pixel = image::load_from_memory(&bytes).unwrap().get_pixel(256, 256);
    assert!(pixel[0] > 200 && pixel[2] < 50);
    let (status, _) = stage(&f, bytes, "image/webp").await;
    assert_eq!(status, 201);
    f.close().await;
}
#[tokio::test]
async fn malformed_animated_invalid_crop_and_foreign_source_never_create_assets() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new().await;
    for bytes in [
        b"<svg><script/></svg>".to_vec(),
        b"GIF89a".to_vec(),
        vec![0; 100],
    ] {
        assert_eq!(stage(&f, bytes, "image/png").await.0, 400);
    }
    let mut animated = png(10, 10);
    animated.splice(33..33, b"\0\0\0\x08acTL\0\0\0\x02\0\0\0\0\0\0\0\0".to_vec());
    assert_eq!(stage(&f, animated, "image/png").await.0, 400);
    let (status, source) = stage(&f, png(10, 10), "image/png").await;
    assert_eq!(status, 201);
    for crop in [
        json!({"left":0,"top":0,"size":11}),
        json!({"left":-1,"top":0,"size":2}),
        json!({"left":0.5,"top":0,"size":2}),
        json!({"left":0,"top":0,"size":0}),
    ] {
        assert_eq!(
            f.request(
                "POST",
                &f.path("/bot-avatars"),
                Some(json!({"sourceId":source["id"],"crop":crop})),
                false,
                Some(&f.owner)
            )
            .await
            .0,
            400
        );
    }
    let foreign = format!("/api/workspaces/{}/bot-avatars", f.foreign);
    assert_eq!(
        f.request(
            "POST",
            &foreign,
            Some(json!({"sourceId":source["id"],"crop":{"left":0,"top":0,"size":10}})),
            true,
            Some(&f.member)
        )
        .await
        .0,
        404
    );
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM avatar_assets")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        raw(
            &f,
            "POST",
            &f.path("/bot-avatars/sources"),
            "image/png",
            Body::from(png(10, 10)),
            true,
            Some(&f.member)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        raw(
            &f,
            "POST",
            &f.path("/bot-avatars/sources"),
            "image/png",
            Body::from(png(10, 10)),
            false,
            None
        )
        .await
        .0,
        403
    );
    f.close().await;
}
#[tokio::test]
async fn source_quota_expiration_and_explicit_deletion_free_capacity() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new().await;
    let mut first = None;
    for _ in 0..8 {
        let (status, source) = stage(&f, png(8, 8), "image/png").await;
        assert_eq!(status, 201, "{source}");
        if first.is_none() {
            first = Some(source);
        }
    }
    assert_eq!(stage(&f, png(8, 8), "image/png").await.0, 409);
    let path = f.path(&format!(
        "/bot-avatars/sources/{}",
        first.unwrap()["id"].as_str().unwrap()
    ));
    assert_eq!(
        f.request(
            "DELETE",
            &path,
            Some(json!({"other":true})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        400
    );
    assert_eq!(
        f.request("DELETE", &path, None, false, Some(&f.owner))
            .await
            .0,
        204
    );
    assert_eq!(stage(&f, png(8, 8), "image/png").await.0, 201);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    sqlx::query("UPDATE avatar_sources SET expires_at=0")
        .execute(&store.pool)
        .await
        .unwrap();
    let (status, source) = stage(&f, png(8, 8), "image/png").await;
    assert_eq!(status, 201, "{source}");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM avatar_sources")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    f.close().await;
}
#[tokio::test]
async fn reserve_before_body_limits_parallel_uploads_and_shutdown_drains_active_reader() {
    let _serial = SERIAL.lock().await;
    let f = Arc::new(Fixture::new().await);
    f.bootstrap().await;
    let sourcepath = f.path("/bot-avatars/sources");
    let pending = {
        let f = f.clone();
        let path = sourcepath.clone();
        tokio::spawn(async move {
            raw(
                &f,
                "POST",
                &path,
                "image/png",
                Body::from_stream(futures_util::stream::pending::<
                    Result<Vec<u8>, std::io::Error>,
                >()),
                false,
                Some(&f.owner),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(stage(&f, png(10, 10), "image/png").await.0, 429);
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), store.close())
        .await
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.0, 409);
    Arc::try_unwrap(f).ok().unwrap().close().await;
}
#[tokio::test]
async fn logout_while_uploading_cancels_before_decode_and_request_drop_releases_slot() {
    let _serial = SERIAL.lock().await;
    let f = Arc::new(Fixture::new().await);
    f.bootstrap().await;
    let pending = {
        let f = f.clone();
        tokio::spawn(async move {
            raw(
                &f,
                "POST",
                &f.path("/bot-avatars/sources"),
                "image/png",
                Body::from_stream(futures_util::stream::pending::<
                    Result<Vec<u8>, std::io::Error>,
                >()),
                false,
                Some(&f.owner),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    pending.abort();
    let _ = pending.await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(stage(&f, png(8, 8), "image/png").await.0, 201);
    let pending = {
        let f = f.clone();
        tokio::spawn(async move {
            raw(
                &f,
                "POST",
                &f.path("/bot-avatars/sources"),
                "image/png",
                Body::from_stream(futures_util::stream::pending::<
                    Result<Vec<u8>, std::io::Error>,
                >()),
                false,
                Some(&f.owner),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.0, 403);
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
    assert_eq!(count, 1);
    Arc::try_unwrap(f).ok().unwrap().close().await;
}
