use super::BotTemplates;
use crate::filesystem::{inspect_entry, open_dir, open_root};
use std::{fs, path::Path};

const NAME: &str = "bot-templates.sqlite";

fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("platform")).unwrap();
    temp
}

#[tokio::test]
async fn wal_store_keeps_data_across_close_and_reopen() {
    let temp = fixture();
    let templates = BotTemplates::open(temp.path()).await.unwrap();
    let mut connection = templates.pool.acquire().await.unwrap();
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    sqlx::query("PRAGMA wal_autocheckpoint=0")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sharing_policies(workspace_id,data) VALUES(?,?)")
        .bind("synthetic-space")
        .bind(r#"{"mode":"disabled"}"#)
        .execute(&mut *connection)
        .await
        .unwrap();
    {
        let root = open_root(temp.path()).unwrap();
        let directory = open_dir(&root, "platform").unwrap();
        for suffix in ["", "-wal", "-shm"] {
            // Query entries, never open/close a live SQLite file for metadata.
            let stamp = inspect_entry(&directory, &format!("{NAME}{suffix}")).unwrap();
            assert!(stamp.is_file() && stamp.single_link());
        }
    }
    drop(connection);
    templates.close().await;
    assert!(templates.pool.is_closed());
    assert!(templates.ensure_open().is_err());

    let reopened = BotTemplates::open(temp.path()).await.unwrap();
    let value: String =
        sqlx::query_scalar("SELECT data FROM sharing_policies WHERE workspace_id=?")
            .bind("synthetic-space")
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
    assert_eq!(value, r#"{"mode":"disabled"}"#);
    reopened.close().await;
    // SQLite may retain or remove its sidecars when the last connection closes.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(temp.path().join("platform").join(NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn every_database_entry_rejects_directories_and_hardlinks_before_sqlite_connects() {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        for hardlink in [false, true] {
            let temp = fixture();
            let outside = tempfile::tempdir().unwrap();
            let canary = outside.path().join("canary");
            fs::write(&canary, b"synthetic unchanged bytes").unwrap();
            let directory = temp.path().join("platform");
            let entry = directory.join(format!("{NAME}{suffix}"));
            if hardlink {
                fs::hard_link(&canary, &entry).unwrap();
            } else {
                fs::create_dir(&entry).unwrap();
            }
            let error = BotTemplates::open(temp.path()).await.err().unwrap();
            assert_eq!(error.status.as_u16(), 503);
            assert_eq!(error.code, "UNAVAILABLE");
            assert_eq!(fs::read(&canary).unwrap(), b"synthetic unchanged bytes");
            if !suffix.is_empty() {
                assert!(!directory.join(NAME).exists());
            }
            assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
        }
    }
}

fn symlink_file(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(target, link)
        .expect("Windows test runner must permit synthetic symlinks");
}

fn symlink_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(target, link)
        .expect("Windows test runner must permit synthetic symlinks");
}

#[tokio::test]
async fn every_database_entry_rejects_symlinks_before_sqlite_connects() {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let temp = fixture();
        let outside = tempfile::tempdir().unwrap();
        let canary = outside.path().join("canary");
        fs::write(&canary, b"synthetic unchanged bytes").unwrap();
        let directory = temp.path().join("platform");
        symlink_file(&canary, &directory.join(format!("{NAME}{suffix}")));
        let error = BotTemplates::open(temp.path()).await.err().unwrap();
        assert_eq!(error.status.as_u16(), 503);
        assert_eq!(error.code, "UNAVAILABLE");
        assert_eq!(fs::read(&canary).unwrap(), b"synthetic unchanged bytes");
        if !suffix.is_empty() {
            assert!(!directory.join(NAME).exists());
        }
        assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
    }
}

#[tokio::test]
async fn linked_root_or_platform_cannot_create_a_template_store_elsewhere() {
    for link_root in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        if link_root {
            fs::create_dir(outside.path().join("platform")).unwrap();
            symlink_dir(outside.path(), &root);
        } else {
            fs::create_dir(&root).unwrap();
            symlink_dir(outside.path(), &root.join("platform"));
        }
        let error = BotTemplates::open(&root).await.err().unwrap();
        assert_eq!(error.status.as_u16(), 503);
        assert_eq!(error.code, "UNAVAILABLE");
        let target = if link_root {
            outside.path().join("platform")
        } else {
            outside.path().to_owned()
        };
        assert_eq!(fs::read_dir(target).unwrap().count(), 0);
    }
}
