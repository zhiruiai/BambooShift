use super::super::{create_dir, create_file, open_for_change, open_root};
use super::*;
use std::io::{Read, Write};

struct Fixture {
    // Drop directory handles before the temporary directory removes itself.
    root: Dir,
    temp: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        Self {
            root: open_root(temp.path()).unwrap(),
            temp,
        }
    }

    fn file(&self, name: &str, bytes: &[u8]) -> File {
        let mut file = create_file(&self.root, name).unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        file
    }

    fn contents(&self, name: &str) -> Vec<u8> {
        std::fs::read(self.temp.path().join(name)).unwrap()
    }
}

#[test]
fn rename_moves_the_retained_file_to_a_relative_unicode_destination() {
    let fixture = Fixture::new();
    let file = fixture.file("source.txt", b"synthetic contents");
    let destination = create_dir(&fixture.root, "nested").unwrap();
    let identity = inspect(&file).unwrap();
    rename_unique(
        &fixture.root,
        "source.txt",
        &file,
        &destination,
        "结果-🦊.txt",
    )
    .unwrap();
    assert!(!fixture.temp.path().join("source.txt").exists());
    let renamed = open_file(&destination, "结果-🦊.txt").unwrap();
    assert!(identity.same_identity(&inspect(&renamed).unwrap()));
    assert_eq!(
        fixture.contents("nested/结果-🦊.txt"),
        b"synthetic contents"
    );
}

#[test]
fn destination_collision_never_replaces_existing_contents_or_identity() {
    let fixture = Fixture::new();
    let source = fixture.file("source.txt", b"source");
    let destination = fixture.file("target.txt", b"target canary");
    let before = inspect(&destination).unwrap();
    drop(destination);
    let error = rename_unique(
        &fixture.root,
        "source.txt",
        &source,
        &fixture.root,
        "target.txt",
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fixture.contents("source.txt"), b"source");
    assert_eq!(fixture.contents("target.txt"), b"target canary");
    assert!(
        before.same_identity(&inspect(&open_file(&fixture.root, "target.txt").unwrap()).unwrap())
    );
}

#[test]
fn mismatched_held_file_cannot_rename_or_delete_another_entry() {
    let fixture = Fixture::new();
    let held = fixture.file("held.txt", b"held canary");
    let named = fixture.file("named.txt", b"named canary");
    assert_eq!(
        remove_matching(&fixture.root, "named.txt", &held)
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        rename_unique(
            &fixture.root,
            "named.txt",
            &held,
            &fixture.root,
            "moved.txt"
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(fixture.contents("held.txt"), b"held canary");
    assert_eq!(fixture.contents("named.txt"), b"named canary");
    assert!(!fixture.temp.path().join("moved.txt").exists());
    drop(named);
}

#[test]
fn invalid_names_are_rejected_before_any_mutation() {
    let fixture = Fixture::new();
    let file = fixture.file("source.txt", b"canary");
    for name in [
        "",
        ".",
        "..",
        "../source.txt",
        "nested/item",
        "nested\\item",
        "name:stream",
        "NUL",
        "COM¹.txt",
        "name.",
        "name ",
        "bad\0name",
    ] {
        assert_eq!(
            rename_unique(&fixture.root, "source.txt", &file, &fixture.root, name)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput,
            "target: {name:?}"
        );
        assert_eq!(
            rename_unique(&fixture.root, name, &file, &fixture.root, "target.txt")
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput,
            "source: {name:?}"
        );
        assert_eq!(
            remove_matching(&fixture.root, name, &file)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput,
            "remove: {name:?}"
        );
    }
    assert_eq!(fixture.contents("source.txt"), b"canary");
    assert!(!fixture.temp.path().join("target.txt").exists());
}

#[test]
fn directory_and_hardlinked_files_are_not_mutation_sources() {
    let fixture = Fixture::new();
    let directory = create_dir(&fixture.root, "folder").unwrap();
    let held_directory = directory.try_clone().unwrap().into_std_file();
    assert!(
        rename_unique(
            &fixture.root,
            "folder",
            &held_directory,
            &fixture.root,
            "moved"
        )
        .is_err()
    );
    assert!(remove_matching(&fixture.root, "folder", &held_directory).is_err());
    std::fs::write(fixture.temp.path().join("one.txt"), b"hardlink canary").unwrap();
    std::fs::hard_link(
        fixture.temp.path().join("one.txt"),
        fixture.temp.path().join("two.txt"),
    )
    .unwrap();
    let linked = open_file(&fixture.root, "one.txt").unwrap();
    assert!(
        rename_unique(
            &fixture.root,
            "one.txt",
            &linked,
            &fixture.root,
            "moved.txt"
        )
        .is_err()
    );
    assert!(remove_matching(&fixture.root, "one.txt", &linked).is_err());
    assert_eq!(fixture.contents("one.txt"), b"hardlink canary");
    assert_eq!(fixture.contents("two.txt"), b"hardlink canary");
}

#[test]
fn removal_reports_when_the_open_file_is_only_marked_for_deletion() {
    let fixture = Fixture::new();
    drop(fixture.file("remove.txt", b"retained contents"));
    let mut file = open_for_change(&fixture.root, "remove.txt").unwrap();
    let result = remove_matching(&fixture.root, "remove.txt", &file).unwrap();
    #[cfg(unix)]
    assert_eq!(result, Removal::Unlinked);
    #[cfg(windows)]
    assert_eq!(result, Removal::DeleteOnClose);
    let mut contents = String::new();
    file.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "retained contents");
    drop(file);
    assert!(!fixture.temp.path().join("remove.txt").exists());
}

#[test]
fn quarantining_published_file_restores_backup_with_an_independent_reader_open() {
    let fixture = Fixture::new();
    let old = fixture.file("document.txt", b"previous revision");
    let new = fixture.file("transaction.tmp", b"new revision");
    let mut reader = open_file(&fixture.root, "transaction.tmp").unwrap();
    rename_unique(
        &fixture.root,
        "document.txt",
        &old,
        &fixture.root,
        "backup.tmp",
    )
    .unwrap();
    rename_unique(
        &fixture.root,
        "transaction.tmp",
        &new,
        &fixture.root,
        "document.txt",
    )
    .unwrap();
    // Rollback frees the visible name by rename, never by a pending deletion.
    rename_unique(
        &fixture.root,
        "document.txt",
        &new,
        &fixture.root,
        "transaction.tmp",
    )
    .unwrap();
    rename_unique(
        &fixture.root,
        "backup.tmp",
        &old,
        &fixture.root,
        "document.txt",
    )
    .unwrap();
    let _disposition = remove_matching(&fixture.root, "transaction.tmp", &new).unwrap();
    drop(new);
    assert_eq!(fixture.contents("document.txt"), b"previous revision");
    let mut observed = String::new();
    reader.read_to_string(&mut observed).unwrap();
    assert_eq!(observed, "new revision");
    drop(reader);
    assert!(!fixture.temp.path().join("transaction.tmp").exists());
    assert!(!fixture.temp.path().join("backup.tmp").exists());
}

#[test]
fn quarantine_collision_preserves_each_version() {
    let fixture = Fixture::new();
    let new = fixture.file("document.txt", b"new revision");
    let old = fixture.file("backup.tmp", b"previous revision");
    let canary = fixture.file("transaction.tmp", b"unrelated canary");
    assert!(
        rename_unique(
            &fixture.root,
            "document.txt",
            &new,
            &fixture.root,
            "transaction.tmp"
        )
        .is_err()
    );
    assert!(
        rename_unique(
            &fixture.root,
            "backup.tmp",
            &old,
            &fixture.root,
            "document.txt"
        )
        .is_err()
    );
    assert_eq!(fixture.contents("document.txt"), b"new revision");
    assert_eq!(fixture.contents("backup.tmp"), b"previous revision");
    assert_eq!(fixture.contents("transaction.tmp"), b"unrelated canary");
    drop(canary);
}

#[cfg(unix)]
#[test]
fn stale_source_and_symlink_replacements_are_never_removed() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let held = fixture.file("source.txt", b"retained original");
    std::fs::rename(
        fixture.temp.path().join("source.txt"),
        fixture.temp.path().join("retained.txt"),
    )
    .unwrap();
    std::fs::write(
        fixture.temp.path().join("source.txt"),
        b"replacement canary",
    )
    .unwrap();
    assert!(remove_matching(&fixture.root, "source.txt", &held).is_err());
    assert!(
        rename_unique(
            &fixture.root,
            "source.txt",
            &held,
            &fixture.root,
            "moved.txt"
        )
        .is_err()
    );
    symlink("retained.txt", fixture.temp.path().join("alias.txt")).unwrap();
    assert!(remove_matching(&fixture.root, "alias.txt", &held).is_err());
    assert!(
        rename_unique(
            &fixture.root,
            "alias.txt",
            &held,
            &fixture.root,
            "moved.txt"
        )
        .is_err()
    );
    assert_eq!(fixture.contents("source.txt"), b"replacement canary");
    assert_eq!(fixture.contents("retained.txt"), b"retained original");
    assert!(fixture.temp.path().join("alias.txt").is_symlink());
}

#[cfg(unix)]
#[test]
fn retained_destination_directory_never_switches_to_replacement_symlink() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    let destination = create_dir(&fixture.root, "destination").unwrap();
    let file = fixture.file("source.txt", b"inside");
    std::fs::rename(
        fixture.temp.path().join("destination"),
        fixture.temp.path().join("retained"),
    )
    .unwrap();
    symlink(outside.path(), fixture.temp.path().join("destination")).unwrap();
    rename_unique(
        &fixture.root,
        "source.txt",
        &file,
        &destination,
        "result.txt",
    )
    .unwrap();
    assert_eq!(fixture.contents("retained/result.txt"), b"inside");
    assert!(!outside.path().join("result.txt").exists());
}

#[cfg(windows)]
#[test]
fn mutation_handle_blocks_external_source_and_parent_rename() {
    let fixture = Fixture::new();
    let held = fixture.file("source.txt", b"held");
    let directory = create_dir(&fixture.root, "directory").unwrap();
    assert!(
        std::fs::rename(
            fixture.temp.path().join("source.txt"),
            fixture.temp.path().join("outside.txt")
        )
        .is_err()
    );
    assert!(
        std::fs::rename(
            fixture.temp.path().join("directory"),
            fixture.temp.path().join("moved")
        )
        .is_err()
    );
    rename_unique(&fixture.root, "source.txt", &held, &directory, "inside.txt").unwrap();
    assert_eq!(fixture.contents("directory/inside.txt"), b"held");
}

#[cfg(windows)]
#[test]
fn read_only_handle_does_not_gain_delete_authority() {
    let fixture = Fixture::new();
    drop(fixture.file("source.txt", b"canary"));
    let reader = open_file(&fixture.root, "source.txt").unwrap();
    assert_eq!(
        rename_unique(
            &fixture.root,
            "source.txt",
            &reader,
            &fixture.root,
            "moved.txt"
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        remove_matching(&fixture.root, "source.txt", &reader)
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(fixture.contents("source.txt"), b"canary");
}

#[cfg(windows)]
#[test]
fn case_insensitive_collision_cannot_replace_an_existing_target() {
    let fixture = Fixture::new();
    let source = fixture.file("source.txt", b"source");
    let target = fixture.file("Report.txt", b"target canary");
    assert!(
        rename_unique(
            &fixture.root,
            "source.txt",
            &source,
            &fixture.root,
            "REPORT.TXT"
        )
        .is_err()
    );
    assert_eq!(fixture.contents("Report.txt"), b"target canary");
    assert_eq!(fixture.contents("source.txt"), b"source");
    drop(target);
}
