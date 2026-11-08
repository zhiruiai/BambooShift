#![cfg(unix)]
mod speech_support;
mod workspace_support;
use speech_support::*;
use workspace_support::Fixture;

#[tokio::test]
async fn local_transcription_uses_private_temporary_audio_and_removes_it_after_completion() {
    let f = Fixture::new().await;
    let marker = configure(&f, false);
    let result = audio(&f, wav(), "audio/wav", Some(&f.owner)).await;
    assert_eq!(result.0, 200, "{}", result.1);
    assert_eq!(result.1["text"], "Synthetic local transcript");
    assert_eq!(result.1["userId"], f.owner);
    let started = started(&marker).await;
    assert!(!std::path::Path::new(started["cwd"].as_str().unwrap()).exists());
    assert!(!std::path::Path::new(started["audio"].as_str().unwrap()).exists());
    assert!(started["host_secret"].is_null());
    let status = f
        .request(
            "GET",
            &f.path("/speech/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status.1["available"], true);
    assert_eq!(status.1["processing"], "server-local");
    f.close().await;
}
#[tokio::test]
async fn invalid_audio_and_forged_account_are_rejected_before_starting_the_binary() {
    let f = Fixture::new().await;
    let marker = configure(&f, false);
    assert_eq!(audio(&f, wav(), "audio/wav", Some(&f.member)).await.0, 403);
    assert_eq!(audio(&f, wav(), "audio/webm", Some(&f.owner)).await.0, 415);
    assert_eq!(
        audio(&f, b"not audio".to_vec(), "audio/wav", Some(&f.owner))
            .await
            .0,
        422
    );
    let mut silent = wav();
    silent[44..].fill(0);
    let result = audio(&f, silent, "audio/wav", Some(&f.owner)).await;
    assert_eq!(result.1["code"], "SPEECH_SILENT");
    assert_eq!(
        audio(
            &f,
            vec![0; 2 * 1024 * 1024 + 1],
            "audio/wav",
            Some(&f.owner)
        )
        .await
        .0,
        413
    );
    assert!(!marker.exists());
    f.close().await;
}
#[tokio::test]
async fn cancelling_the_http_future_kills_the_real_child_before_releasing_user_capacity() {
    let f = std::sync::Arc::new(Fixture::new().await);
    let marker = configure(&f, true);
    let worker = f.clone();
    let request =
        tokio::spawn(async move { audio(&worker, wav(), "audio/wav", Some(&worker.owner)).await });
    let metadata = started(&marker).await;
    assert_eq!(
        audio(&f, wav(), "audio/wav", Some(&f.owner)).await.1["code"],
        "SPEECH_ALREADY_PENDING"
    );
    request.abort();
    let _ = request.await;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let pid = metadata["pid"].as_i64().unwrap() as i32;
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive && !std::path::Path::new(metadata["cwd"].as_str().unwrap()).exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    configure(&f, false);
    assert_eq!(audio(&f, wav(), "audio/wav", Some(&f.owner)).await.0, 200);
    let f = std::sync::Arc::try_unwrap(f).ok().unwrap();
    f.close().await;
}
#[tokio::test]
async fn revoking_the_original_session_stops_recognition_and_returns_no_transcript() {
    let f = std::sync::Arc::new(Fixture::new().await);
    let marker = configure(&f, true);
    let worker = f.clone();
    let request =
        tokio::spawn(async move { audio(&worker, wav(), "audio/wav", Some(&worker.owner)).await });
    let metadata = started(&marker).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    let result = request.await.unwrap();
    assert_eq!(result.0, 403);
    assert!(result.1.get("text").is_none());
    assert!(!std::path::Path::new(metadata["audio"].as_str().unwrap()).exists());
    assert_ne!(
        unsafe { libc::kill(metadata["pid"].as_i64().unwrap() as i32, 0) },
        0
    );
    let f = std::sync::Arc::try_unwrap(f).ok().unwrap();
    f.close().await;
}
