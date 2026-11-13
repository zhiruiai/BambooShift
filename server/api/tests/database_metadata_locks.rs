use openbot_backend::filesystem;
use sqlx::{
    Connection, SqliteConnection,
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};
use std::{path::Path, process::Stdio, time::Duration};

const CHILD_PATH: &str = "BAMBOOSHIFT_METADATA_LOCK_TEST_DATABASE";
const CHILD_MODE: &str = "BAMBOOSHIFT_METADATA_LOCK_TEST_MODE";
const BUSY_CONFIRMED: &str = "synthetic-sqlite-busy-confirmed";
const WRITE_CONFIRMED: &str = "synthetic-sqlite-write-confirmed";

async fn probe_in_another_process(database: &Path, expect_busy: bool) {
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "database_metadata_lock_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_PATH, database)
        .env(CHILD_MODE, if expect_busy { "busy" } else { "write" })
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .expect("Synthetic SQLite child timed out")
        .expect("Synthetic SQLite child could not start");
    assert!(
        output.status.success(),
        "Synthetic SQLite child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let marker = if expect_busy {
        BUSY_CONFIRMED
    } else {
        WRITE_CONFIRMED
    };
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(marker),
        "The selected child test did not execute its database assertion"
    );
}

async fn metadata_keeps_the_writer_lock(mode: SqliteJournalMode, sidecars: bool) {
    let temporary = tempfile::Builder::new()
        .prefix("bambooshift-metadata-lock-")
        .tempdir()
        .unwrap();
    let database = temporary.path().join("synthetic.sqlite");
    // Exactly one SQLite connection lives in the parent. Closing an additional
    // parent connection can itself release POSIX locks and invalidate this test.
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&database)
            .create_if_missing(true)
            .journal_mode(mode)
            .busy_timeout(Duration::ZERO),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE probe (id INTEGER PRIMARY KEY, writer TEXT NOT NULL)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO probe(writer) VALUES ('parent')")
        .execute(&mut connection)
        .await
        .unwrap();
    let root = filesystem::open_root(temporary.path()).unwrap();
    let names = if sidecars {
        vec![
            "synthetic.sqlite",
            "synthetic.sqlite-wal",
            "synthetic.sqlite-shm",
        ]
    } else {
        vec!["synthetic.sqlite"]
    };
    let original: Vec<_> = names
        .iter()
        .map(|name| filesystem::inspect_entry(&root, name).unwrap())
        .collect();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .unwrap();
    // A baseline failure proves another process actually sees the held lock.
    probe_in_another_process(&database, true).await;
    for _ in 0..3 {
        for _ in 0..64 {
            for (name, expected) in names.iter().zip(&original) {
                let current = filesystem::inspect_entry(&root, name).unwrap();
                assert!(current.is_file());
                assert!(current.single_link());
                assert!(current.same_identity(expected));
            }
        }
        // Opening and then closing the same inode for metadata on Unix would
        // drop this process's SQLite locks, so this must still be SQLITE_BUSY.
        probe_in_another_process(&database, true).await;
    }
    sqlx::query("ROLLBACK")
        .execute(&mut connection)
        .await
        .unwrap();
    probe_in_another_process(&database, false).await;
    let writes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM probe WHERE writer='child'")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(writes, 1, "The positive control must commit a real write");
    connection.close().await.unwrap();
    drop(root);
    temporary.close().unwrap();
}

#[tokio::test]
async fn metadata_inspection_preserves_rollback_journal_writer_lock() {
    metadata_keeps_the_writer_lock(SqliteJournalMode::Delete, false).await;
}

#[tokio::test]
async fn metadata_inspection_preserves_wal_and_shared_memory_writer_lock() {
    metadata_keeps_the_writer_lock(SqliteJournalMode::Wal, true).await;
}

#[tokio::test]
#[ignore = "Invoked only by this test binary's synthetic cross-process lock probes"]
async fn database_metadata_lock_child() {
    let path = std::env::var_os(CHILD_PATH).expect("Missing synthetic database path");
    let path = Path::new(&path);
    assert_eq!(path.file_name().unwrap(), "synthetic.sqlite");
    let mode = std::env::var(CHILD_MODE).expect("Missing synthetic probe mode");
    assert!(matches!(mode.as_str(), "busy" | "write"));
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .busy_timeout(Duration::ZERO),
    )
    .await
    .unwrap();
    let result = sqlx::query("INSERT INTO probe(writer) VALUES ('child')")
        .execute(&mut connection)
        .await;
    if mode == "busy" {
        let error = result.expect_err("A competing process wrote through the held SQLite lock");
        let database_error = error.as_database_error().expect("Expected a SQLite error");
        let code = database_error
            .code()
            .unwrap()
            .parse::<i32>()
            .expect("Expected a numeric SQLite result code");
        assert_eq!(
            code & 0xff,
            5,
            "Expected SQLITE_BUSY, not an unrelated error"
        );
        println!("{BUSY_CONFIRMED}");
    } else {
        assert_eq!(result.unwrap().rows_affected(), 1);
        println!("{WRITE_CONFIRMED}");
    }
    connection.close().await.unwrap();
}
