use super::super::{create_dir, open_file, open_root};
use super::{inspect, inspect_entry};
use std::{fs, io};

#[test]
fn entry_and_handle_queries_have_the_same_complete_stamp() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("document.sqlite"), b"synthetic bytes").unwrap();
    let root = open_root(temporary.path()).unwrap();
    let held = open_file(&root, "document.sqlite").unwrap();
    let entry = inspect_entry(&root, "document.sqlite").unwrap();
    assert!(entry.is_file());
    assert!(entry.single_link());
    assert_eq!(entry.len(), 15);
    assert_eq!(entry, inspect(&held).unwrap());
    let child = create_dir(&root, "nested").unwrap();
    let directory = inspect_entry(&root, "nested").unwrap();
    assert!(directory.is_dir());
    assert_eq!(directory, inspect(&child.into_std_file()).unwrap());
}

#[test]
fn entry_query_tracks_changes_and_does_not_hide_multiple_links() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("document.sqlite");
    fs::write(&path, b"before").unwrap();
    let root = open_root(temporary.path()).unwrap();
    let before = inspect_entry(&root, "document.sqlite").unwrap();
    fs::write(&path, b"longer content").unwrap();
    let after = inspect_entry(&root, "document.sqlite").unwrap();
    assert!(before.same_identity(&after));
    assert_ne!(before.version_key(), after.version_key());
    fs::hard_link(&path, temporary.path().join("alias.sqlite")).unwrap();
    let linked = inspect_entry(&root, "alias.sqlite").unwrap();
    assert!(after.same_identity(&linked));
    assert!(!linked.single_link());
    assert!(
        !inspect_entry(&root, "document.sqlite")
            .unwrap()
            .single_link()
    );
}

#[test]
fn entry_query_distinguishes_missing_entries_from_invalid_names() {
    let temporary = tempfile::tempdir().unwrap();
    let root = open_root(temporary.path()).unwrap();
    assert_eq!(
        inspect_entry(&root, "missing.sqlite").unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    for name in [
        "",
        ".",
        "..",
        "../outside",
        "nested/file",
        "nested\\file",
        "name:stream",
        "NUL",
        "file.",
        "file ",
        "nul\0name",
    ] {
        assert_eq!(
            inspect_entry(&root, name).unwrap_err().kind(),
            io::ErrorKind::InvalidInput,
            "{name:?}"
        );
    }
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 0);
}

#[test]
fn entry_query_rejects_file_and_directory_links_without_reading_the_target() {
    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let canary = outside.path().join("canary.sqlite");
    fs::write(&canary, b"outside canary").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(&canary, temporary.path().join("file-link")).unwrap();
        symlink(outside.path(), temporary.path().join("directory-link")).unwrap();
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        symlink_file(&canary, temporary.path().join("file-link"))
            .expect("Windows test runner must permit synthetic symlinks");
        symlink_dir(outside.path(), temporary.path().join("directory-link"))
            .expect("Windows test runner must permit synthetic symlinks");
    }
    let root = open_root(temporary.path()).unwrap();
    for name in ["file-link", "directory-link"] {
        assert_eq!(
            inspect_entry(&root, name).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }
    assert_eq!(fs::read(&canary).unwrap(), b"outside canary");
}

#[cfg(unix)]
#[test]
fn metadata_query_never_opens_a_fifo_or_requires_read_permission() {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    };
    let temporary = tempfile::tempdir().unwrap();
    let fifo = temporary.path().join("fifo");
    let raw = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
    let file = temporary.path().join("attributes-only.sqlite");
    fs::write(&file, b"content").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
    let root = open_root(temporary.path()).unwrap();
    let fifo = inspect_entry(&root, "fifo").unwrap();
    assert!(!fifo.is_file());
    assert!(!fifo.is_dir());
    let result = inspect_entry(&root, "attributes-only.sqlite");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(result.unwrap().len(), 7);
}

#[cfg(windows)]
#[test]
fn entry_query_is_compatible_with_a_database_handle_that_does_not_share_delete() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("live.sqlite");
    fs::write(&path, b"synthetic database bytes").unwrap();
    let root = open_root(temporary.path()).unwrap();
    let database = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&path)
        .unwrap();
    assert_eq!(
        inspect_entry(&root, "live.sqlite").unwrap(),
        inspect(&database).unwrap()
    );
    drop(database);
    // The metadata query must not retain a handle that prevents sidecar cleanup.
    fs::rename(&path, temporary.path().join("moved.sqlite")).unwrap();
    fs::remove_file(temporary.path().join("moved.sqlite")).unwrap();
}
