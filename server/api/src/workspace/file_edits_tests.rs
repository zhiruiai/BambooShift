use super::*;
use std::os::unix::fs::symlink;

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
fn nofollow_rejects_links_special_files_and_escaping_paths_without_touching_canaries() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("private");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("canary"), b"UNCHANGED").unwrap();
    symlink(&outside, root.join("link")).unwrap();
    std::fs::hard_link(outside.join("canary"), root.join("hard")).unwrap();
    let fifo = std::ffi::CString::new(root.join("fifo").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    for name in [
        "../private/canary",
        "/private/canary",
        "link/canary",
        "hard",
        "fifo",
        "a\\b",
        ".openbot-secret",
    ] {
        assert!(directory.edit(name, true).is_err(), "{name}");
    }
    assert_eq!(std::fs::read(outside.join("canary")).unwrap(), b"UNCHANGED");
    assert!(directory.list(".").unwrap().is_empty());
}

#[test]
fn intervening_file_replacement_rejects_publication_and_cleans_only_our_temp() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let file = temp.path().join("workspace/report.txt");
    std::fs::write(&file, b"BEFORE").unwrap();
    {
        let mut edit = directory.edit("report.txt", true).unwrap();
        edit.previous().unwrap();
        edit.stage(b"STALE").unwrap();
        std::fs::rename(&file, temp.path().join("old.txt")).unwrap();
        std::fs::write(&file, b"NEW CANARY").unwrap();
        assert!(edit.publish().is_err());
    }
    assert_eq!(std::fs::read(&file).unwrap(), b"NEW CANARY");
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
fn rollback_cleans_a_pinned_parent_after_directory_rename_without_touching_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let root = temp.path().join("workspace");
    std::fs::create_dir(root.join("dir")).unwrap();
    std::fs::write(root.join("dir/report.txt"), b"ORIGINAL").unwrap();
    {
        let mut edit = directory.edit("dir/report.txt", true).unwrap();
        edit.stage(b"SENSITIVE").unwrap();
        edit.publish().unwrap();
        std::fs::rename(root.join("dir"), root.join("moved")).unwrap();
        std::fs::create_dir(root.join("dir")).unwrap();
        std::fs::write(root.join("dir/report.txt"), b"CANARY").unwrap();
    }
    assert_eq!(
        std::fs::read(root.join("dir/report.txt")).unwrap(),
        b"CANARY"
    );
    assert_eq!(
        std::fs::read(root.join("moved/report.txt")).unwrap(),
        b"ORIGINAL"
    );
    assert_eq!(std::fs::read_dir(root.join("moved")).unwrap().count(), 1);
}
