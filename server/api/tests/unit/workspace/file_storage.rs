use super::*;
use std::{fs, io::Write, path::Path};

#[cfg(unix)]
#[test]
fn held_directory_read_never_follows_concurrently_swapped_parent_symlink() {
    use std::{
        os::unix::fs::symlink,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };
    let dir = tempfile::tempdir().unwrap();
    let root = Directory::open(dir.path(), true).unwrap();
    let workspace = dir.path().join("workspace");
    let parent = workspace.join("folder");
    let moved = workspace.join("held");
    let outside = dir.path().join("outside");
    std::fs::create_dir(&parent).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(parent.join("same.txt"), b"inside").unwrap();
    std::fs::write(outside.join("same.txt"), b"private-canary").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = stop.clone();
        let outside = outside.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::fs::rename(&parent, &moved).unwrap();
                symlink(&outside, &parent).unwrap();
                std::thread::yield_now();
                std::fs::remove_file(&parent).unwrap();
                std::fs::rename(&moved, &parent).unwrap();
            }
        })
    };
    for _ in 0..600 {
        if let Ok(bytes) = root
            .reader("folder/same.txt")
            .and_then(|mut reader| reader.next())
            .map(|v| v.unwrap())
        {
            assert_eq!(bytes, b"inside");
        }
    }
    stop.store(true, Ordering::SeqCst);
    thread.join().unwrap();
    assert_eq!(
        std::fs::read(outside.join("same.txt")).unwrap(),
        b"private-canary"
    );
}
#[test]
fn aborted_upload_and_delete_rollback_use_original_directory_after_rename() {
    let dir = tempfile::tempdir().unwrap();
    let root = Directory::open(dir.path(), true).unwrap();
    let workspace = dir.path().join("workspace");
    let moved = dir.path().join("moved");
    let (_, upload) = root
        .upload("same.txt", b"transient", &uuid::Uuid::new_v4().to_string())
        .unwrap();
    #[cfg(unix)]
    let actual = {
        fs::rename(&workspace, &moved).unwrap();
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("same.txt"), b"replacement-canary").unwrap();
        moved.clone()
    };
    #[cfg(windows)]
    let actual = {
        let error = fs::rename(&workspace, &moved).unwrap_err();
        assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
        assert!(!moved.exists());
        assert_eq!(fs::read(workspace.join("same.txt")).unwrap(), b"transient");
        workspace.clone()
    };
    drop(upload);
    assert!(!actual.join("same.txt").exists());
    #[cfg(unix)]
    assert_eq!(
        std::fs::read(workspace.join("same.txt")).unwrap(),
        b"replacement-canary"
    );
    let (_, upload) = root
        .upload(
            "keep.txt",
            b"keep-original",
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    upload.commit();
    let removed = root.remove("keep.txt").unwrap();
    assert!(!actual.join("keep.txt").exists());
    drop(removed);
    assert_eq!(
        std::fs::read(actual.join("keep.txt")).unwrap(),
        b"keep-original"
    );
    assert_eq!(std::fs::read_dir(&actual).unwrap().count(), 1);
}

fn staged_delete(workspace: &Path) -> std::path::PathBuf {
    let staged: Vec<_> = fs::read_dir(workspace)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(".openbot-delete-")
        })
        .collect();
    assert_eq!(staged.len(), 1);
    staged.into_iter().next().unwrap()
}

#[cfg(windows)]
fn assert_rename_blocked(source: &Path, target: &Path) {
    let error = fs::rename(source, target).unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
    assert!(!target.exists());
}

#[test]
fn upload_rollback_never_removes_a_replacement_at_the_published_name() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    let (_, upload) = directory
        .upload(
            "report.txt",
            b"transient",
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    let moved = workspace.join("our-moved-upload.txt");
    #[cfg(unix)]
    {
        fs::rename(workspace.join("report.txt"), &moved).unwrap();
        fs::write(workspace.join("report.txt"), b"replacement canary").unwrap();
    }
    #[cfg(windows)]
    {
        assert_rename_blocked(&workspace.join("report.txt"), &moved);
        assert_eq!(
            fs::read(workspace.join("report.txt")).unwrap(),
            b"transient"
        );
    }
    drop(upload);
    #[cfg(unix)]
    assert_eq!(
        fs::read(workspace.join("report.txt")).unwrap(),
        b"replacement canary"
    );
    #[cfg(windows)]
    assert!(!workspace.join("report.txt").exists());
    // The guard may remove or clear its own moved file; it must not retain partial content.
    if moved.exists() {
        assert!(fs::read(moved).unwrap().is_empty());
    }
}

#[test]
fn deletion_rollback_keeps_a_recreated_target_and_preserves_the_original() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let workspace = temp.path().join("workspace");
    fs::write(workspace.join("report.txt"), b"original").unwrap();
    let removed = directory.remove("report.txt").unwrap();
    let staged = staged_delete(&workspace);
    fs::write(workspace.join("report.txt"), b"replacement canary").unwrap();
    drop(removed);
    assert_eq!(
        fs::read(workspace.join("report.txt")).unwrap(),
        b"replacement canary"
    );
    assert_eq!(fs::read(staged).unwrap(), b"original");
}

#[test]
fn deletion_cleanup_and_rollback_do_not_touch_a_replaced_staging_name() {
    for commit in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let directory = Directory::open(temp.path(), true).unwrap();
        let workspace = temp.path().join("workspace");
        fs::write(workspace.join("report.txt"), b"original").unwrap();
        let removed = directory.remove("report.txt").unwrap();
        let staged = staged_delete(&workspace);
        let moved = workspace.join("original-moved.txt");
        #[cfg(unix)]
        {
            fs::rename(&staged, &moved).unwrap();
            fs::write(&staged, b"staging replacement canary").unwrap();
            if commit {
                assert!(removed.commit().is_err());
            } else {
                drop(removed);
            }
            assert!(!workspace.join("report.txt").exists());
            assert_eq!(fs::read(&staged).unwrap(), b"staging replacement canary");
            assert_eq!(fs::read(moved).unwrap(), b"original");
        }
        #[cfg(windows)]
        {
            assert_rename_blocked(&staged, &moved);
            assert_eq!(fs::read(&staged).unwrap(), b"original");
            if commit {
                removed.commit().unwrap();
                assert!(!workspace.join("report.txt").exists());
            } else {
                drop(removed);
                assert_eq!(fs::read(workspace.join("report.txt")).unwrap(), b"original");
            }
            assert!(!staged.exists());
        }
    }
}

#[test]
fn readers_recheck_mutations_between_chunks_and_keep_stamps_bound_to_identity() {
    let temp = tempfile::tempdir().unwrap();
    let directory = Directory::open(temp.path(), true).unwrap();
    let file = temp.path().join("workspace/report.txt");
    fs::write(&file, vec![b'x'; 64 * 1024 + 10]).unwrap();
    let mut reader = directory.reader("report.txt").unwrap();
    let stamp = reader.stamp().unwrap();
    assert_eq!(reader.next().unwrap().unwrap().len(), 64 * 1024);
    fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(b"changed")
        .unwrap();
    assert_eq!(reader.next().unwrap_err().status.as_u16(), 409);
    assert!(reader.stamp().is_err());
    let current = directory.reader("report.txt").unwrap();
    assert_ne!(current.stamp().unwrap(), stamp);
    let current_stamp = current.stamp().unwrap();
    let contents = fs::read(&file).unwrap();
    fs::rename(&file, temp.path().join("old-report.txt")).unwrap();
    fs::write(&file, contents).unwrap();
    assert_ne!(
        directory.reader("report.txt").unwrap().stamp().unwrap(),
        current_stamp
    );
}

#[test]
fn missing_workspace_parent_and_file_keep_the_file_not_found_classification() {
    let temp = tempfile::tempdir().unwrap();
    let missing_workspace = Directory::open(temp.path(), false).err().unwrap();
    assert_eq!(missing_workspace.status.as_u16(), 404);
    assert_eq!(missing_workspace.code, "FILE_NOT_FOUND");
    let directory = Directory::open(temp.path(), true).unwrap();
    for error in [
        directory.reader("missing.txt").err().unwrap(),
        directory.reader("missing/report.txt").err().unwrap(),
        directory.remove("missing.txt").err().unwrap(),
        directory.list("missing").unwrap_err(),
        directory.edit("missing/report.txt", false).err().unwrap(),
    ] {
        assert_eq!(error.status.as_u16(), 404);
        assert_eq!(error.code, "FILE_NOT_FOUND");
    }
}
