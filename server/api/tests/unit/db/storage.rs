use super::DatabaseFiles;
use std::fs;

const NAME: &str = "fixture.sqlite";

fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("spaces/source")).unwrap();
    temp
}

#[test]
fn readonly_missing_storage_is_never_created_and_prepare_only_creates_main() {
    let temp = fixture();
    let directory = temp.path().join("spaces/source");
    assert!(DatabaseFiles::open(temp.path(), &["spaces", "source"], NAME).is_err());
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
    assert!(DatabaseFiles::prepare(temp.path(), &["missing"], NAME).is_err());
    assert!(!temp.path().join("missing").exists());
    let files = DatabaseFiles::prepare(temp.path(), &["spaces", "source"], NAME).unwrap();
    assert_eq!(files.directory(), directory);
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(files.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    files.check().unwrap();
}

#[test]
fn changing_contents_and_recreating_sidecars_preserves_main_identity() {
    let temp = fixture();
    let files = DatabaseFiles::prepare(temp.path(), &["spaces", "source"], NAME).unwrap();
    fs::write(files.path(), b"synthetic database bytes").unwrap();
    files.check().unwrap();
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = files.directory().join(format!("{NAME}{suffix}"));
        for _ in 0..2 {
            fs::write(&sidecar, b"synthetic sidecar").unwrap();
            files.check().unwrap();
            fs::remove_file(&sidecar).unwrap();
            files.check().unwrap();
        }
    }
    fs::remove_file(files.path()).unwrap();
    assert!(files.check().is_err());
    assert!(!files.path().exists());
}

#[test]
fn main_and_every_sidecar_reject_directories_and_hardlinks_without_touching_target() {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        for hardlink in [false, true] {
            let temp = fixture();
            let directory = temp.path().join("spaces/source");
            if !suffix.is_empty() {
                fs::write(directory.join(NAME), b"main").unwrap();
            }
            let target = temp.path().join("canary");
            fs::write(&target, b"never change").unwrap();
            let candidate = directory.join(format!("{NAME}{suffix}"));
            if hardlink {
                fs::hard_link(&target, &candidate).unwrap();
            } else {
                fs::create_dir(&candidate).unwrap();
            }
            assert!(DatabaseFiles::prepare(temp.path(), &["spaces", "source"], NAME).is_err());
            assert!(DatabaseFiles::open(temp.path(), &["spaces", "source"], NAME).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"never change");
        }
    }
}

#[test]
fn main_and_every_sidecar_reject_symlinks_without_touching_target() {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let temp = fixture();
        let directory = temp.path().join("spaces/source");
        if !suffix.is_empty() {
            fs::write(directory.join(NAME), b"main").unwrap();
        }
        let target = temp.path().join("canary");
        fs::write(&target, b"never change").unwrap();
        let candidate = directory.join(format!("{NAME}{suffix}"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &candidate).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &candidate)
            .expect("Windows test runner must permit synthetic symlinks");
        assert!(DatabaseFiles::prepare(temp.path(), &["spaces", "source"], NAME).is_err());
        assert!(DatabaseFiles::open(temp.path(), &["spaces", "source"], NAME).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"never change");
    }
}

#[test]
fn new_sidecar_hardlink_and_main_replacement_invalidate_existing_description() {
    let temp = fixture();
    let files = DatabaseFiles::prepare(temp.path(), &["spaces", "source"], NAME).unwrap();
    let target = temp.path().join("canary");
    fs::write(&target, b"never change").unwrap();
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = files.directory().join(format!("{NAME}{suffix}"));
        fs::hard_link(&target, &sidecar).unwrap();
        assert!(files.check().is_err());
        fs::remove_file(sidecar).unwrap();
        files.check().unwrap();
    }
    fs::rename(files.path(), files.directory().join("previous.sqlite")).unwrap();
    fs::write(files.path(), b"replacement").unwrap();
    assert!(files.check().is_err());
    assert_eq!(fs::read(&target).unwrap(), b"never change");
    assert_eq!(fs::read(files.path()).unwrap(), b"replacement");
}

#[test]
fn currently_named_root_and_each_parent_must_match_the_opened_chain() {
    for relative in ["", "spaces", "spaces/source"] {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("data");
        fs::create_dir_all(root.join("spaces/source")).unwrap();
        let files = DatabaseFiles::prepare(&root, &["spaces", "source"], NAME).unwrap();
        let selected = root.join(relative);
        let moved = outer.path().join("moved");
        let rename = fs::rename(&selected, &moved);
        #[cfg(windows)]
        if let Err(error) = &rename {
            assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
            files.check().unwrap();
            continue;
        }
        rename.unwrap();
        fs::create_dir_all(root.join("spaces/source")).unwrap();
        fs::write(root.join("spaces/source").join(NAME), b"replacement").unwrap();
        assert!(files.check().is_err(), "replacement of {relative}");
        assert_eq!(
            fs::read(root.join("spaces/source").join(NAME)).unwrap(),
            b"replacement"
        );
    }
}
