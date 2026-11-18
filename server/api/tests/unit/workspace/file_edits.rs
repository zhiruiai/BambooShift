use super::*;
use std::fs;

#[cfg(windows)]
fn assert_rename_blocked(source: &std::path::Path, target: &std::path::Path) {
    let error = fs::rename(source, target).unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
    assert!(!target.exists());
}

fn transaction_file(workspace: &std::path::Path, prefix: &str) -> std::path::PathBuf {
    let paths: Vec<_> = fs::read_dir(workspace)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(prefix)
        })
        .collect();
    assert_eq!(paths.len(), 1);
    paths.into_iter().next().unwrap()
}

#[test]
fn commit_and_rollback_preserve_the_actual_original_inode_contents() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let mut first = directory.edit("reports/中文.txt", true).unwrap();
    assert!(first.previous().unwrap().is_none());
    first.stage("原始内容".as_bytes()).unwrap();
    first.publish().unwrap();
    first.commit();
    {
        let mut changed = directory.edit("reports/中文.txt", true).unwrap();
        assert_eq!(changed.previous().unwrap().unwrap(), "原始内容".as_bytes());
        changed.stage(b"ROLLBACK").unwrap();
        changed.publish().unwrap();
        assert_eq!(
            std::fs::read(temp.path().join("workspace/reports/中文.txt")).unwrap(),
            b"ROLLBACK"
        );
    }
    assert_eq!(
        std::fs::read(temp.path().join("workspace/reports/中文.txt")).unwrap(),
        "原始内容".as_bytes()
    );
    assert_eq!(
        std::fs::read_dir(temp.path().join("workspace/reports"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn rejects_hardlinks_escaping_paths_and_internal_names_without_touching_canaries() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("private");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("canary"), b"UNCHANGED").unwrap();
    std::fs::hard_link(outside.join("canary"), root.join("hard")).unwrap();
    for name in [
        "../private/canary",
        "/private/canary",
        "hard",
        "a\\b",
        "C:canary.txt",
        "NUL.txt",
        ".openbot-secret",
    ] {
        assert!(directory.edit(name, true).is_err(), "{name}");
    }
    assert_eq!(std::fs::read(outside.join("canary")).unwrap(), b"UNCHANGED");
    assert!(directory.list(".").unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn nofollow_rejects_symlinks_and_fifos_without_touching_canaries() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("private");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("canary"), b"UNCHANGED").unwrap();
    symlink(&outside, root.join("link")).unwrap();
    symlink(outside.join("canary"), root.join("file-link")).unwrap();
    let fifo = std::ffi::CString::new(root.join("fifo").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    for name in ["link/canary", "file-link", "fifo"] {
        assert!(directory.edit(name, true).is_err(), "{name}");
    }
    assert_eq!(fs::read(outside.join("canary")).unwrap(), b"UNCHANGED");
    assert!(directory.list(".").unwrap().is_empty());
}

#[test]
fn intervening_changes_reject_publication_and_clean_only_our_temp() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let file = temp.path().join("workspace/report.txt");
    std::fs::write(&file, b"BEFORE").unwrap();
    {
        let mut edit = directory.edit("report.txt", true).unwrap();
        edit.previous().unwrap();
        edit.stage(b"STALE").unwrap();
        #[cfg(unix)]
        fs::rename(&file, temp.path().join("old.txt")).unwrap();
        #[cfg(windows)]
        assert_rename_blocked(&file, &temp.path().join("old.txt"));
        // Windows protects the name while held; concurrent content changes must
        // still invalidate the captured version rather than being overwritten.
        std::fs::write(&file, b"NEW CANARY").unwrap();
        assert!(edit.publish().is_err());
    }
    assert_eq!(std::fs::read(&file).unwrap(), b"NEW CANARY");
    #[cfg(unix)]
    assert_eq!(
        std::fs::read(temp.path().join("old.txt")).unwrap(),
        b"BEFORE"
    );
    assert_eq!(
        std::fs::read_dir(temp.path().join("workspace"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn replaced_temporary_name_cannot_publish_another_files_contents() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    let report = workspace.join("report.txt");
    fs::write(&report, b"ORIGINAL").unwrap();
    let mut edit = directory.edit("report.txt", false).unwrap();
    edit.stage(b"OURS").unwrap();
    let staged = transaction_file(&workspace, ".openbot-edit-");
    let moved = workspace.join("our-moved-edit.txt");
    #[cfg(unix)]
    {
        fs::rename(&staged, &moved).unwrap();
        fs::write(&staged, b"STAGING CANARY").unwrap();
        assert!(edit.publish().is_err());
    }
    #[cfg(windows)]
    {
        assert_rename_blocked(&staged, &moved);
        edit.publish().unwrap();
        assert_eq!(fs::read(&report).unwrap(), b"OURS");
    }
    drop(edit);
    assert_eq!(fs::read(&report).unwrap(), b"ORIGINAL");
    #[cfg(unix)]
    {
        assert_eq!(fs::read(staged).unwrap(), b"STAGING CANARY");
        if moved.exists() {
            assert!(fs::read(moved).unwrap().is_empty());
        }
    }
    #[cfg(windows)]
    assert_eq!(fs::read_dir(&workspace).unwrap().count(), 1);
}

#[test]
fn rollback_cleans_a_pinned_parent_after_directory_rename_without_touching_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let root = temp.path().join("workspace");
    std::fs::create_dir(root.join("dir")).unwrap();
    std::fs::write(root.join("dir/report.txt"), b"ORIGINAL").unwrap();
    let restored;
    {
        let mut edit = directory.edit("dir/report.txt", true).unwrap();
        edit.stage(b"SENSITIVE").unwrap();
        edit.publish().unwrap();
        #[cfg(unix)]
        {
            fs::rename(root.join("dir"), root.join("moved")).unwrap();
            fs::create_dir(root.join("dir")).unwrap();
            fs::write(root.join("dir/report.txt"), b"CANARY").unwrap();
            restored = root.join("moved");
        }
        #[cfg(windows)]
        {
            let error = fs::rename(root.join("dir"), root.join("moved")).unwrap_err();
            assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
            assert!(!root.join("moved").exists());
            assert_eq!(fs::read(root.join("dir/report.txt")).unwrap(), b"SENSITIVE");
            restored = root.join("dir");
        }
    }
    #[cfg(unix)]
    assert_eq!(
        std::fs::read(root.join("dir/report.txt")).unwrap(),
        b"CANARY"
    );
    assert_eq!(
        std::fs::read(restored.join("report.txt")).unwrap(),
        b"ORIGINAL"
    );
    assert_eq!(std::fs::read_dir(restored).unwrap().count(), 1);
}

#[test]
fn new_file_publication_never_overwrites_a_target_created_after_staging() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    let mut edit = directory.edit("report.txt", false).unwrap();
    assert!(edit.previous().unwrap().is_none());
    edit.stage(b"OURS").unwrap();
    fs::write(workspace.join("report.txt"), b"CANARY").unwrap();
    assert!(edit.publish().is_err());
    drop(edit);
    assert_eq!(fs::read(workspace.join("report.txt")).unwrap(), b"CANARY");
    assert_eq!(fs::read_dir(&workspace).unwrap().count(), 1);
}

#[test]
fn rollback_after_publication_preserves_a_concurrent_replacement_and_the_backup() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    let path = workspace.join("report.txt");
    fs::write(&path, b"ORIGINAL").unwrap();
    let mut edit = directory.edit("report.txt", false).unwrap();
    edit.stage(b"OURS").unwrap();
    edit.publish().unwrap();
    #[cfg(unix)]
    {
        fs::rename(&path, workspace.join("our-moved-edit.txt")).unwrap();
        fs::write(&path, b"CANARY").unwrap();
    }
    #[cfg(windows)]
    assert_rename_blocked(&path, &workspace.join("our-moved-edit.txt"));
    drop(edit);
    #[cfg(unix)]
    {
        assert_eq!(fs::read(&path).unwrap(), b"CANARY");
        let backup = transaction_file(&workspace, ".openbot-backup-");
        assert_eq!(fs::read(backup).unwrap(), b"ORIGINAL");
    }
    #[cfg(windows)]
    {
        assert_eq!(fs::read(&path).unwrap(), b"ORIGINAL");
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 1);
    }
}

#[test]
fn rollback_does_not_restore_a_replaced_backup_over_the_original_path() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    fs::write(workspace.join("report.txt"), b"ORIGINAL").unwrap();
    let mut edit = directory.edit("report.txt", false).unwrap();
    edit.stage(b"OURS").unwrap();
    edit.publish().unwrap();
    let backup = transaction_file(&workspace, ".openbot-backup-");
    #[cfg(unix)]
    {
        fs::rename(&backup, workspace.join("original-moved.txt")).unwrap();
        fs::write(&backup, b"BACKUP CANARY").unwrap();
    }
    #[cfg(windows)]
    assert_rename_blocked(&backup, &workspace.join("original-moved.txt"));
    drop(edit);
    #[cfg(unix)]
    {
        assert!(!workspace.join("report.txt").exists());
        assert_eq!(fs::read(&backup).unwrap(), b"BACKUP CANARY");
        assert_eq!(
            fs::read(workspace.join("original-moved.txt")).unwrap(),
            b"ORIGINAL"
        );
    }
    #[cfg(windows)]
    {
        assert_eq!(fs::read(workspace.join("report.txt")).unwrap(), b"ORIGINAL");
        assert!(!backup.exists());
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 1);
    }
}

#[test]
fn rollback_never_truncates_a_visible_file_when_its_temporary_name_is_recreated() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    let report = workspace.join("report.txt");
    fs::write(&report, b"ORIGINAL").unwrap();
    let mut edit = directory.edit("report.txt", false).unwrap();
    edit.stage(b"PUBLISHED").unwrap();
    let temporary = transaction_file(&workspace, ".openbot-edit-");
    edit.publish().unwrap();
    let backup = transaction_file(&workspace, ".openbot-backup-");
    fs::write(&temporary, b"TEMPORARY CANARY").unwrap();
    drop(edit);
    assert_eq!(fs::read(&temporary).unwrap(), b"TEMPORARY CANARY");
    let visible = fs::read(&report).unwrap();
    if visible == b"ORIGINAL" {
        // A fresh quarantine name permits full restoration without overwriting
        // the file another writer created at the old transaction name.
        assert!(!backup.exists());
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 2);
    } else {
        // If rollback cannot move the published object, preserve both versions
        // for recovery. In particular, never truncate the still-visible file.
        assert_eq!(visible, b"PUBLISHED");
        assert_eq!(fs::read(backup).unwrap(), b"ORIGINAL");
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 3);
    }
}

#[test]
fn directory_listing_is_sorted_and_hides_internal_and_nonordinary_entries() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    fs::write(workspace.join("z.txt"), b"z").unwrap();
    fs::write(workspace.join("a.txt"), b"a").unwrap();
    fs::create_dir(workspace.join("middle")).unwrap();
    fs::write(workspace.join(".openbot-edit-private"), b"hidden").unwrap();
    fs::write(temp.path().join("outside.txt"), b"CANARY").unwrap();
    fs::hard_link(temp.path().join("outside.txt"), workspace.join("hard")).unwrap();
    #[cfg(unix)]
    {
        fs::write(workspace.join("NUL.txt"), b"nonportable").unwrap();
        fs::write(workspace.join("stream:part"), b"nonportable").unwrap();
        std::os::unix::fs::symlink(temp.path(), workspace.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(
            temp.path().join("outside.txt"),
            workspace.join("linked-file"),
        )
        .unwrap();
    }
    assert_eq!(
        directory.list(".").unwrap(),
        vec![
            json!({"name":"a.txt","directory":false}),
            json!({"name":"middle","directory":true}),
            json!({"name":"z.txt","directory":false}),
        ]
    );
    assert!(directory.list("middle").unwrap().is_empty());
    assert_eq!(
        fs::read(temp.path().join("outside.txt")).unwrap(),
        b"CANARY"
    );
}
