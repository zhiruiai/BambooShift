use super::*;
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn assert_contended(data: &Path) {
    let error = DeploymentLock::acquire(data).err().expect("second writer");
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert!(error.to_string().contains("another Rust backend"));
}

#[test]
fn one_writer_owns_directory_until_file_closes_without_unlinking_it() {
    let root = tempfile::tempdir().unwrap();
    let first = DeploymentLock::acquire(root.path()).unwrap();
    let lock = root.path().join("platform/backend.lock");
    let before = inspect(&File::open(&lock).unwrap()).unwrap();
    assert_contended(root.path());
    drop(first);
    assert!(lock.is_file());
    let second = DeploymentLock::acquire(root.path()).unwrap();
    let after = inspect(&File::open(&lock).unwrap()).unwrap();
    assert!(before.same_identity(&after));
    drop(second);
    assert!(!root.path().join("platform/identity.sqlite").exists());
}

#[test]
fn creates_missing_data_components_without_rewriting_existing_lock_contents() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("new/nested/data");
    drop(DeploymentLock::acquire(&data).unwrap());
    let lock = data.join("platform/backend.lock");
    std::fs::write(&lock, b"preserve").unwrap();
    drop(DeploymentLock::acquire(&data).unwrap());
    assert_eq!(std::fs::read(lock).unwrap(), b"preserve");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [data.clone(), data.join("platform")] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            std::fs::metadata(data.join("platform/backend.lock"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600,
        );
    }
}

#[test]
fn new_data_paths_keep_root_rules_for_trailing_components_and_parent_traversal() {
    let root = tempfile::tempdir().unwrap();
    for suffix in ["nested/data/", "other/./data/."] {
        let data = root.path().join(suffix);
        drop(DeploymentLock::acquire(&data).unwrap());
        assert!(data.join("platform/backend.lock").is_file());
    }
    let traversal = root.path().join("must-not-exist/../outside");
    let error = DeploymentLock::acquire(&traversal).err().unwrap();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(!root.path().join("must-not-exist").exists());
    assert!(!root.path().join("outside").exists());
}

#[test]
fn contention_is_distinct_from_other_lock_errors() {
    let error = lock_error(TryLockError::Error(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "denied",
    )));
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(error.to_string(), "denied");
    let error = lock_error(TryLockError::Error(io::Error::from_raw_os_error(9)));
    assert_eq!(error.raw_os_error(), Some(9));
    assert_eq!(
        lock_error(TryLockError::WouldBlock).kind(),
        io::ErrorKind::AlreadyExists
    );
}

#[test]
fn hardlinked_or_non_file_lock_is_rejected_without_touching_target() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let canary = external.path().join("canary");
    std::fs::write(&canary, b"unchanged").unwrap();
    std::fs::create_dir(root.path().join("platform")).unwrap();
    let lock = root.path().join("platform/backend.lock");
    std::fs::hard_link(&canary, &lock).unwrap();
    assert!(DeploymentLock::acquire(root.path()).is_err());
    assert_eq!(std::fs::read(&canary).unwrap(), b"unchanged");
    std::fs::remove_file(&lock).unwrap();
    std::fs::create_dir(&lock).unwrap();
    assert!(DeploymentLock::acquire(root.path()).is_err());
}

#[test]
fn symlinks_at_data_platform_or_lock_are_rejected_without_touching_targets() {
    #[cfg(unix)]
    use std::os::unix::fs::{symlink as symlink_dir, symlink as symlink_file};
    #[cfg(windows)]
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let canary = external.path().join("canary");
    std::fs::write(&canary, b"unchanged").unwrap();
    let data = root.path().join("data");
    symlink_dir(external.path(), &data).unwrap();
    assert!(DeploymentLock::acquire(&data).is_err());
    assert!(!external.path().join("platform").exists());
    remove_directory_link(&data);
    std::fs::create_dir(&data).unwrap();
    let platform = data.join("platform");
    symlink_dir(external.path(), &platform).unwrap();
    assert!(DeploymentLock::acquire(&data).is_err());
    assert!(!external.path().join("backend.lock").exists());
    remove_directory_link(&platform);
    std::fs::create_dir(&platform).unwrap();
    symlink_file(&canary, platform.join("backend.lock")).unwrap();
    assert!(DeploymentLock::acquire(&data).is_err());
    assert_eq!(std::fs::read(&canary).unwrap(), b"unchanged");
}

fn remove_directory_link(path: &Path) {
    #[cfg(unix)]
    std::fs::remove_file(path).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(path).unwrap();
}

#[cfg(unix)]
#[test]
fn fifo_lock_fails_without_blocking_for_a_peer() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("platform")).unwrap();
    let lock = CString::new(
        root.path()
            .join("platform/backend.lock")
            .as_os_str()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(unsafe { libc::mkfifo(lock.as_ptr(), 0o600) }, 0);
    assert!(DeploymentLock::acquire(root.path()).is_err());
}

#[test]
fn process_lock_excludes_other_processes_and_releases_on_normal_exit() {
    let root = tempfile::tempdir().unwrap();
    let mut child = TestChild::start(root.path(), false);
    assert_contended(root.path());
    child.0.stdin.take().unwrap().write_all(b"close").unwrap();
    assert!(child.0.wait().unwrap().success());
    drop(DeploymentLock::acquire(root.path()).unwrap());
}

#[test]
fn process_termination_releases_its_lock() {
    let root = tempfile::tempdir().unwrap();
    let mut child = TestChild::start(root.path(), false);
    assert_contended(root.path());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    // Windows may complete cleanup shortly after reporting process termination.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match DeploymentLock::acquire(root.path()) {
            Ok(lock) => {
                drop(lock);
                break;
            }
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("terminated process left its lock held: {error}"),
        }
    }
}

#[test]
fn child_process_does_not_inherit_the_deployment_lock_handle() {
    let root = tempfile::tempdir().unwrap();
    let held = DeploymentLock::acquire(root.path()).unwrap();
    let mut child = TestChild::start(root.path(), true);
    drop(held);
    // The unrelated child remains alive. It must not prolong our lock lifetime.
    assert!(child.0.try_wait().unwrap().is_none());
    drop(DeploymentLock::acquire(root.path()).unwrap());
    child.0.stdin.take().unwrap().write_all(b"close").unwrap();
    assert!(child.0.wait().unwrap().success());
}

struct TestChild(Child);

impl TestChild {
    fn start(data: &Path, wait_only: bool) -> Self {
        let mut child = Self(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "deployment_lock::tests::child_holds_lock",
                    "--nocapture",
                ])
                .env("BAMBOOSHIFT_LOCK_TEST_DIR", data)
                .env(
                    "BAMBOOSHIFT_LOCK_TEST_WAIT_ONLY",
                    if wait_only { "1" } else { "0" },
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let ready = data.join("ready");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("child lock process exited before ready: {status}");
            }
            if Instant::now() >= deadline {
                panic!("child lock process did not become ready");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child
    }
}

impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn child_holds_lock() {
    let Some(data) = std::env::var_os("BAMBOOSHIFT_LOCK_TEST_DIR") else {
        return;
    };
    let data = Path::new(&data);
    let _lock = (std::env::var("BAMBOOSHIFT_LOCK_TEST_WAIT_ONLY").unwrap() != "1")
        .then(|| DeploymentLock::acquire(data).unwrap());
    std::fs::write(data.join("ready"), b"ready").unwrap();
    let mut signal = [0; 1];
    std::io::stdin().read_exact(&mut signal).unwrap();
}

#[cfg(windows)]
#[test]
fn held_windows_lock_cannot_be_renamed_and_is_released_normally() {
    let root = tempfile::tempdir().unwrap();
    let held = DeploymentLock::acquire(root.path()).unwrap();
    let lock = root.path().join("platform/backend.lock");
    let renamed = root.path().join("platform/renamed.lock");
    assert!(std::fs::rename(&lock, &renamed).is_err());
    assert_contended(root.path());
    drop(held);
    std::fs::rename(&lock, &renamed).unwrap();
    std::fs::rename(&renamed, &lock).unwrap();
    drop(DeploymentLock::acquire(root.path()).unwrap());
}
