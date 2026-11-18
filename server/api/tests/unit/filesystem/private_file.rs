use super::*;

fn files(directory: &Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn first_save_and_replacement_publish_complete_documents_without_temporary_files() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config/connection.json");
    write_private(&path, b"first synthetic document").unwrap();
    write_private(&path, b"second synthetic document").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"second synthetic document");
    assert_eq!(files(path.parent().unwrap()), ["connection.json"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn partial_write_failure_preserves_previous_document_and_cleans_its_temporary_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("connection.json");
    write_private(&path, b"previous synthetic document").unwrap();
    let result = publish(
        &path,
        |file| {
            file.write_all(b"partial")?;
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "synthetic write failure",
            ))
        },
        |_| panic!("directory sync must not run before publication"),
    );
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::WriteZero);
    assert_eq!(std::fs::read(path).unwrap(), b"previous synthetic document");
    assert_eq!(files(temp.path()), ["connection.json"]);
}

#[test]
fn failed_replacement_preserves_destination_directory_and_removes_temporary_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("connection.json");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("canary"), b"retained").unwrap();
    assert!(write_private(&path, b"new synthetic document").is_err());
    assert_eq!(std::fs::read(path.join("canary")).unwrap(), b"retained");
    assert_eq!(files(temp.path()), ["connection.json"]);
}

#[test]
fn directory_sync_failure_is_a_published_result_not_an_uncommitted_error() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("connection.json");
    write_private(&path, b"previous synthetic document").unwrap();
    let result = publish(
        &path,
        |file| {
            file.write_all(b"new synthetic document")?;
            file.sync_all()
        },
        |_| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "synthetic sync failure",
            ))
        },
    );
    assert_eq!(
        result.unwrap(),
        DirectorySync::Unconfirmed(io::ErrorKind::PermissionDenied)
    );
    assert_eq!(std::fs::read(path).unwrap(), b"new synthetic document");
    assert_eq!(files(temp.path()), ["connection.json"]);
}

#[test]
fn ordinary_directory_sync_reports_the_platform_contract() {
    let temp = tempfile::tempdir().unwrap();
    let directory = crate::filesystem::open_root(temp.path())
        .unwrap()
        .into_std_file();
    let actual = sync_directory(&directory).unwrap();
    #[cfg(unix)]
    assert_eq!(actual, DirectorySync::Confirmed);
    #[cfg(not(unix))]
    assert_eq!(actual, DirectorySync::Unsupported);
}

#[cfg(unix)]
#[test]
fn redirected_parent_is_rejected_without_touching_the_target() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("connection.json"), b"canary").unwrap();
    std::os::unix::fs::symlink(outside.path(), temp.path().join("config")).unwrap();
    assert!(write_private(&temp.path().join("config/connection.json"), b"new").is_err());
    assert_eq!(
        std::fs::read(outside.path().join("connection.json")).unwrap(),
        b"canary"
    );
    assert_eq!(files(outside.path()), ["connection.json"]);
}

#[cfg(windows)]
#[test]
fn windows_sharing_violation_keeps_previous_document_and_cleans_temporary_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("connection.json");
    write_private(&path, b"previous synthetic document").unwrap();
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert!(write_private(&path, b"new synthetic document").is_err());
    drop(held);
    assert_eq!(std::fs::read(path).unwrap(), b"previous synthetic document");
    assert_eq!(files(temp.path()), ["connection.json"]);
}
