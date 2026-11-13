use super::*;
use std::fs;

fn file(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"synthetic executable fixture").unwrap();
}

#[test]
fn windows_searches_only_native_exe_without_using_shell_extensions() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("native programs");
    file(&bin.join("node"));
    file(&bin.join("node.cmd"));
    file(&bin.join("node.bat"));
    assert!(resolve(Path::new("node"), [bin.clone()], temp.path(), ".exe").is_none());
    file(&bin.join("node.exe"));
    for name in ["node", "node.exe"] {
        assert_eq!(
            resolve(Path::new(name), [bin.clone()], temp.path(), ".exe"),
            Some(bin.join("node.exe"))
        );
    }
    for name in ["node.cmd", "node.bat", "node.com", "node."] {
        file(&bin.join(name));
        assert!(resolve(Path::new(name), [bin.clone()], temp.path(), ".exe").is_none());
        assert!(resolve(&bin.join(name), [bin.clone()], temp.path(), ".exe").is_none());
    }
    assert!(resolve(Path::new("node/"), [bin.clone()], temp.path(), ".exe").is_none());
    file(&bin.join("alternate.EXE"));
    assert_eq!(
        resolve(
            Path::new("alternate.EXE"),
            [bin.clone()],
            temp.path(),
            ".exe"
        ),
        Some(bin.join("alternate.EXE"))
    );
}

#[test]
fn empty_or_relative_search_entries_cannot_select_the_current_directory() {
    let temp = tempfile::tempdir().unwrap();
    let installed = temp.path().join("installed");
    file(&temp.path().join("node"));
    file(&installed.join("node"));
    let search = [
        PathBuf::new(),
        PathBuf::from("."),
        PathBuf::from("relative"),
    ];
    assert!(resolve(Path::new("node"), search.clone(), temp.path(), "").is_none());
    assert_eq!(
        resolve(
            Path::new("node"),
            search.into_iter().chain([installed.clone()]),
            temp.path(),
            ""
        ),
        Some(installed.join("node"))
    );
}

#[test]
fn explicit_paths_are_anchored_before_worker_chdir_and_never_fall_back() {
    let temp = tempfile::tempdir().unwrap();
    let selected = temp.path().join("chosen tools/node");
    let other = temp.path().join("runtime/chosen tools/node");
    file(&selected);
    file(&other);
    for suffix in ["", ".exe"] {
        let selected = native_name(&selected, suffix).unwrap();
        let other = native_name(&other, suffix).unwrap();
        file(&selected);
        file(&other);
        let resolved = resolve(
            Path::new("chosen tools/node"),
            [other.parent().unwrap().to_owned()],
            temp.path(),
            suffix,
        );
        assert_eq!(resolved, Some(selected.clone()));
        assert_eq!(
            resolve(&selected, [], temp.path(), suffix),
            Some(selected.clone())
        );
        fs::remove_file(&selected).unwrap();
        assert!(
            resolve(
                Path::new("chosen tools/node"),
                [other.parent().unwrap().to_owned()],
                temp.path(),
                suffix
            )
            .is_none()
        );
        assert!(
            resolve(
                &selected,
                [other.parent().unwrap().to_owned()],
                temp.path(),
                suffix
            )
            .is_none()
        );
    }
}

#[test]
fn explicit_current_directory_is_allowed_but_not_implicit_path_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let selected = temp.path().join("node");
    file(&selected);
    assert_eq!(
        resolve(Path::new("./node"), [], temp.path(), ""),
        Some(temp.path().join("./node"))
    );
    assert!(resolve(Path::new("node"), [], temp.path(), "").is_none());
    assert!(resolve(Path::new("./node"), [], Path::new("relative"), "").is_none());
}

#[test]
fn sibling_program_uses_native_extension_and_cargo_deps_parent() {
    let temp = tempfile::tempdir().unwrap();
    for suffix in ["", ".exe"] {
        let worker = temp.path().join(format!("openbot-image-worker{suffix}"));
        file(&worker);
        for executable in ["backend", "deps/backend-test"] {
            assert_eq!(
                sibling(
                    &temp.path().join(executable),
                    "openbot-image-worker",
                    suffix
                ),
                Some(worker.clone())
            );
        }
        assert!(
            sibling(
                Path::new("relative/backend"),
                "openbot-image-worker",
                suffix
            )
            .is_none()
        );
        assert!(sibling(&temp.path().join("backend"), "nested/worker", suffix).is_none());
        fs::remove_file(worker).unwrap();
    }
    file(&temp.path().join("openbot-image-worker"));
    assert!(
        sibling(
            &temp.path().join("backend.exe"),
            "openbot-image-worker",
            ".exe"
        )
        .is_none()
    );
}

#[test]
fn directories_are_not_programs() {
    let temp = tempfile::tempdir().unwrap();
    for suffix in ["", ".exe"] {
        fs::create_dir(temp.path().join(format!("node{suffix}"))).unwrap();
        assert!(
            resolve(
                Path::new("node"),
                [temp.path().to_owned()],
                temp.path(),
                suffix
            )
            .is_none()
        );
        assert!(sibling(&temp.path().join("backend"), "node", suffix).is_none());
    }
    assert!(resolve(Path::new(""), [temp.path().to_owned()], temp.path(), "").is_none());
}

#[cfg(unix)]
#[test]
fn unix_node_symlinks_remain_supported_but_sibling_workers_must_be_regular() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("node-versioned");
    file(&target);
    let alias = temp.path().join("node");
    symlink(&target, &alias).unwrap();
    assert_eq!(
        resolve(Path::new("node"), [temp.path().to_owned()], temp.path(), ""),
        Some(alias.clone())
    );
    assert_eq!(resolve(&alias, [], temp.path(), ""), Some(alias));
    assert!(sibling(&temp.path().join("backend"), "node", "").is_none());
    fs::remove_file(target).unwrap();
    assert!(resolve(Path::new("node"), [temp.path().to_owned()], temp.path(), "").is_none());
}
