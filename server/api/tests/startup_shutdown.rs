use openbot_backend::{config::Config, db::State};
use std::{fs::OpenOptions, os::fd::AsRawFd, process::Stdio, time::Duration};
use tokio::process::Command;

#[tokio::test]
async fn termination_during_database_initialization_is_latched_before_scheduler_or_setup() {
    let directory = tempfile::tempdir().unwrap();
    let state = State::open(Config::local(directory.path())).await.unwrap();
    state.close().await;
    let pool = sqlx::SqlitePool::connect(&format!(
        "sqlite:{}",
        directory.path().join("platform/identity.sqlite").display()
    ))
    .await
    .unwrap();
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("CREATE TABLE startup_fixture(value TEXT)")
        .execute(&mut *transaction)
        .await
        .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_openbot-backend"))
        .arg("--data-dir")
        .arg(directory.path())
        .args(["--bind", "127.0.0.1:0", "--init-operator"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let lock = directory.path().join("platform/backend.lock");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let held = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock)
            .ok()
            .is_some_and(
                |file| unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0,
            );
        if held {
            break;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "Backend exited before acquiring its deployment lock"
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "Backend never acquired its deployment lock"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGTERM) },
        0
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    transaction.rollback().await.unwrap();
    let output = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("openbot:ready"));
    assert!(
        !directory
            .path()
            .join("platform/operator-setup-code")
            .exists()
    );
    assert!(!directory.path().join("spaces").exists());
    pool.close().await;
}
