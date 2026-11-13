use super::inspect;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

fn directory_handle(path: &Path) -> File {
    #[cfg(unix)]
    {
        File::open(path).unwrap()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap()
    }
}

#[test]
fn held_handles_share_identity_but_equal_contents_do_not() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("original.txt");
    let other = temp.path().join("other.txt");
    fs::write(&path, b"same").unwrap();
    fs::write(&other, b"same").unwrap();
    let first = inspect(&File::open(&path).unwrap()).unwrap();
    let reopened = inspect(&File::open(&path).unwrap()).unwrap();
    let different = inspect(&File::open(&other).unwrap()).unwrap();
    assert!(first.is_file());
    assert!(!first.is_dir());
    assert!(first.single_link());
    assert_eq!(first.len(), 4);
    assert!(!first.is_empty());
    assert_eq!(first, reopened);
    assert_eq!(first, first.clone());
    assert_eq!(first.version_key(), reopened.version_key());
    assert!(first.same_identity(&reopened));
    assert!(!first.same_identity(&different));
    assert_ne!(first.version_key(), different.version_key());
    let directory = inspect(&directory_handle(temp.path())).unwrap();
    assert!(directory.is_dir());
    assert!(!directory.is_file());
}

#[test]
fn content_mutation_changes_the_stamp_without_changing_the_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("content.txt");
    fs::write(&path, b"before").unwrap();
    let held = File::open(&path).unwrap();
    let before = inspect(&held).unwrap();
    {
        let mut writer = OpenOptions::new().append(true).open(&path).unwrap();
        writer.write_all(b" after").unwrap();
        writer.sync_all().unwrap();
    }
    let after = inspect(&held).unwrap();
    assert_eq!(after.len(), 12);
    assert!(before.same_identity(&after));
    assert_ne!(before, after);
    assert_ne!(before.version_key(), after.version_key());
}

#[test]
fn hardlinks_keep_identity_and_revoke_single_link_status() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("original.txt");
    let alias = temp.path().join("alias.txt");
    fs::write(&path, b"content").unwrap();
    let held = File::open(&path).unwrap();
    let before = inspect(&held).unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let after = inspect(&held).unwrap();
    let linked = inspect(&File::open(&alias).unwrap()).unwrap();
    assert!(before.single_link());
    assert!(!after.single_link());
    assert!(!linked.single_link());
    assert!(before.same_identity(&after));
    assert!(after.same_identity(&linked));
    assert_ne!(before.version_key(), after.version_key());
}

#[test]
fn attributes_change_the_version_without_changing_file_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("attributes.txt");
    fs::write(&path, b"unchanged content").unwrap();
    let held = File::open(&path).unwrap();
    let before = inspect(&held).unwrap();
    let original = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let after = inspect(&held);
    fs::set_permissions(&path, original).unwrap();
    let after = after.unwrap();
    assert_eq!(before.len(), after.len());
    assert!(before.same_identity(&after));
    assert_ne!(before, after);
    assert_ne!(before.version_key(), after.version_key());
}

#[cfg(windows)]
#[test]
fn reparse_file_and_directory_handles_are_rejected_without_following_them() {
    use std::os::windows::fs::{OpenOptionsExt, symlink_dir, symlink_file};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target.txt");
    let file_link = temp.path().join("file-link");
    let dir_link = temp.path().join("directory-link");
    fs::write(&target, b"canary").unwrap();
    symlink_file(&target, &file_link).expect("Windows test runner must permit synthetic symlinks");
    symlink_dir(temp.path(), &dir_link)
        .expect("Windows test runner must permit synthetic symlinks");
    for path in [&file_link, &dir_link] {
        let link = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap();
        let error = inspect(&link).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }
    assert_eq!(fs::read(&target).unwrap(), b"canary");
}
