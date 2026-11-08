use super::*;
use std::{
    os::unix::fs::symlink,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[test]
fn held_directory_read_never_follows_concurrently_swapped_parent_symlink() {
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
    std::fs::rename(&workspace, &moved).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("same.txt"), b"replacement-canary").unwrap();
    drop(upload);
    assert!(!moved.join("same.txt").exists());
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
    assert!(!moved.join("keep.txt").exists());
    drop(removed);
    assert_eq!(
        std::fs::read(moved.join("keep.txt")).unwrap(),
        b"keep-original"
    );
    assert_eq!(std::fs::read_dir(&moved).unwrap().count(), 1);
}
