use std::{
    fs::{File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
};

pub struct DeploymentLock {
    _file: File,
}
impl DeploymentLock {
    pub fn acquire(data: &Path) -> io::Result<Self> {
        for directory in [data.to_owned(), data.join("platform")] {
            let mut builder = std::fs::DirBuilder::new();
            use std::os::unix::fs::DirBuilderExt;
            builder.recursive(true).mode(0o700);
            builder.create(&directory)?;
            if !std::fs::symlink_metadata(directory)?.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Deployment data must use ordinary directories.",
                ));
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(data.join("platform/backend.lock"))?;
        let info = file.metadata()?;
        if !info.is_file() || info.nlink() != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The deployment lock must be an ordinary private file.",
            ));
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "This data directory is already owned by another Rust backend. Stop it before starting another instance.",
            ));
        }
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_writer_owns_the_directory_until_its_actual_file_handle_closes() {
        let root = tempfile::tempdir().unwrap();
        let first = DeploymentLock::acquire(root.path()).unwrap();
        assert!(DeploymentLock::acquire(root.path()).is_err());
        drop(first);
        assert!(DeploymentLock::acquire(root.path()).is_ok());
        assert!(!root.path().join("platform/identity.sqlite").exists());
    }
    #[test]
    fn redirected_or_hardlinked_lock_paths_never_touch_the_target() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let canary = external.path().join("canary");
        std::fs::write(&canary, b"unchanged").unwrap();
        std::fs::create_dir(root.path().join("platform")).unwrap();
        let lock = root.path().join("platform/backend.lock");
        symlink(&canary, &lock).unwrap();
        assert!(DeploymentLock::acquire(root.path()).is_err());
        std::fs::remove_file(&lock).unwrap();
        std::fs::hard_link(&canary, &lock).unwrap();
        assert!(DeploymentLock::acquire(root.path()).is_err());
        assert_eq!(std::fs::read(&canary).unwrap(), b"unchanged");
        std::fs::remove_file(&lock).unwrap();
        std::fs::remove_dir(root.path().join("platform")).unwrap();
        symlink(external.path(), root.path().join("platform")).unwrap();
        assert!(DeploymentLock::acquire(root.path()).is_err());
        assert!(!external.path().join("backend.lock").exists());
    }
}
