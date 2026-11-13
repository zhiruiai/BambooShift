use super::*;
use std::io::Read;

#[test]
fn reads_nested_files_through_retained_directory_handles() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("nested")).unwrap();
    std::fs::write(temp.path().join("nested/page.html"), b"synthetic page").unwrap();
    let root = open_root(temp.path()).unwrap();
    let nested = open_dir(&root, "nested").unwrap();
    let mut contents = String::new();
    open_file(&nested, "page.html")
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    assert_eq!(contents, "synthetic page");
    assert!(open_file(&root, "nested").is_err());
    assert!(open_dir(&nested, "page.html").is_err());
}

#[test]
fn child_names_cannot_traverse_or_use_windows_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let root = open_root(temp.path()).unwrap();
    for name in [
        "",
        ".",
        "..",
        "a/../b",
        "a/b",
        "a\\b",
        "a/",
        "a\0b",
        "a:b",
        "a.",
        "a ",
        "NUL",
        "con.txt",
        "COM1",
        "lpt9.txt",
        "COM¹.txt",
        "CONIN$",
        "CONOUT$",
    ] {
        assert_eq!(
            open_file(&root, name).unwrap_err().kind(),
            io::ErrorKind::InvalidInput,
            "{name:?}"
        );
        assert_eq!(
            open_dir(&root, name).unwrap_err().kind(),
            io::ErrorKind::InvalidInput,
            "{name:?}"
        );
    }
    // Similar ordinary names remain valid and do not accidentally hit devices.
    std::fs::write(temp.path().join("console.txt"), b"ok").unwrap();
    assert!(open_file(&root, "console.txt").is_ok());
}

#[cfg(unix)]
#[test]
fn rejects_links_even_with_trailing_separator_or_dot_on_root() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), b"outside canary").unwrap();
    symlink(outside.path(), temp.path().join("link")).unwrap();
    symlink(
        outside.path().join("secret.txt"),
        temp.path().join("file-link"),
    )
    .unwrap();
    let root = open_root(temp.path()).unwrap();
    assert!(open_dir(&root, "link").is_err());
    assert!(open_file(&root, "file-link").is_err());
    for path in [
        temp.path().join("link"),
        temp.path().join("link/"),
        temp.path().join("link/."),
    ] {
        assert!(open_root(&path).is_err(), "{path:?}");
    }
}

#[cfg(unix)]
#[test]
fn retained_parent_never_switches_to_replacement_link() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("nested")).unwrap();
    std::fs::write(temp.path().join("nested/item.txt"), b"inside").unwrap();
    std::fs::write(outside.path().join("item.txt"), b"outside").unwrap();
    let root = open_root(temp.path()).unwrap();
    let held = open_dir(&root, "nested").unwrap();
    std::fs::rename(temp.path().join("nested"), temp.path().join("moved")).unwrap();
    symlink(outside.path(), temp.path().join("nested")).unwrap();
    let mut text = String::new();
    open_file(&held, "item.txt")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "inside");
    assert!(open_dir(&root, "nested").is_err());
}
