use super::*;
use crate::{config::Config, test_process::spawn_waiting_child, workspace::access};
use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn fixture() -> (tempfile::TempDir, State, WorkspaceAccess) {
    let dir = tempfile::tempdir().unwrap();
    let state = State::open(Config::local(dir.path())).await.unwrap();
    let user = uuid::Uuid::new_v4().to_string();
    let wid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users VALUES(?,'synthetic@example.test','Synthetic','unused','active','user',1)").bind(&user).execute(&state.pool).await.unwrap();
    sqlx::query("INSERT INTO workspaces VALUES(?,'Synthetic','personal','active',?,1)")
        .bind(&wid)
        .bind(&wid)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',1)")
        .bind(&wid)
        .bind(&user)
        .execute(&state.pool)
        .await
        .unwrap();
    let token = "a".repeat(43);
    sqlx::query("INSERT INTO account_sessions VALUES(?,?,?,'account','Synthetic',1,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(hex::encode(Sha256::digest(token.as_bytes())))
        .bind(&user)
        .bind(crate::db::now() + 60_000)
        .execute(&state.pool)
        .await
        .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("openbot_account={token}").parse().unwrap(),
    );
    headers.insert("x-openbot-expected-user", user.parse().unwrap());
    let access = access::require(&state, &headers, &wid, true, true)
        .await
        .unwrap();
    (dir, state, access)
}
#[tokio::test]
async fn cancelled_process_is_reaped_before_capacity_and_shutdown_finish() {
    let _serial = SERIAL.lock().await;
    let (_dir, state, grant) = fixture().await;
    let jobs = Arc::new(AvatarJobs::default());
    let lease = jobs.reserve().unwrap();
    let (child, probe) = spawn_waiting_child().await.unwrap();
    let (started, receive) = oneshot::channel();
    let task = {
        let state = state.clone();
        tokio::spawn(async move {
            lease
                .run(move |job| async move {
                    let _ = started.send(());
                    process_child(&job, &state, &grant, child, b"{}".to_vec()).await
                })
                .await
        })
    };
    receive.await.unwrap();
    assert!(probe.is_running().unwrap());
    task.abort();
    let _ = task.await;
    tokio::time::timeout(Duration::from_secs(2), jobs.close())
        .await
        .unwrap();
    assert!(jobs.active.lock().unwrap().is_empty());
    assert!(!probe.is_running().unwrap());
    assert!(jobs.reserve().is_err());
    state.close().await;
}
#[tokio::test]
async fn revoked_identity_terminates_real_child_and_releases_slot_after_exit() {
    let _serial = SERIAL.lock().await;
    let (_dir, state, grant) = fixture().await;
    let jobs = Arc::new(AvatarJobs::default());
    let lease = jobs.reserve().unwrap();
    let (child, probe) = spawn_waiting_child().await.unwrap();
    let (started, receive) = oneshot::channel();
    let task = {
        let state = state.clone();
        tokio::spawn(async move {
            lease
                .run(move |job| async move {
                    let _ = started.send(());
                    process_child(&job, &state, &grant, child, b"{}".to_vec()).await
                })
                .await
        })
    };
    receive.await.unwrap();
    assert!(probe.is_running().unwrap());
    sqlx::query("DELETE FROM account_sessions")
        .execute(&state.pool)
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().status.as_u16(), 403);
    assert!(!probe.is_running().unwrap());
    assert!(jobs.reserve().is_ok());
    jobs.close().await;
    state.close().await;
}

#[tokio::test]
async fn global_capacity_is_shared_by_workspaces_and_released_after_lease_end() {
    let _serial = SERIAL.lock().await;
    let first = Arc::new(AvatarJobs::default());
    let second = Arc::new(AvatarJobs::default());
    let third = Arc::new(AvatarJobs::default());
    let one = first.reserve().unwrap();
    assert!(first.reserve().is_err());
    let two = second.reserve().unwrap();
    assert_eq!(third.reserve().err().unwrap().status.as_u16(), 429);
    drop(one);
    let three = third.reserve().unwrap();
    drop(two);
    drop(three);
    first.close().await;
    second.close().await;
    third.close().await;
}
