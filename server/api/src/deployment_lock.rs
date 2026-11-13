use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use fs4::{FileExt, TryLockError};
use openbot_backend::filesystem::{inspect, open_root};
use std::{fs::File, io, path::Path};

/// Owns the deployment until shutdown has finished and the file handle closes.
/// Never unlink the lock file: a replacement inode could admit a second writer.
pub struct DeploymentLock {
    file: File,
    _data: Dir,
    _platform: Dir,
}

impl DeploymentLock {
    pub fn acquire(data: &Path) -> io::Result<Self> {
        let data = open_or_create_data(data)?;
        let platform = create_child(&data, Path::new("platform"))?;
        let file = platform
            .open_with("backend.lock", &lock_options())?
            .into_std();
        validate_lock(&file)?;
        FileExt::try_lock(&file).map_err(lock_error)?;
        validate_lock(&file)?;
        Ok(Self {
            file,
            _data: data,
            _platform: platform,
        })
    }
}

impl Drop for DeploymentLock {
    fn drop(&mut self) {
        // Explicitly release on normal Windows shutdown; closing the owned file
        // immediately afterwards also releases the lock if unlocking fails.
        let _ = FileExt::unlock(&self.file);
    }
}

fn lock_error(error: TryLockError) -> io::Error {
    match error {
        TryLockError::WouldBlock => io::Error::new(
            io::ErrorKind::AlreadyExists,
            "This data directory is already owned by another Rust backend. Stop it before starting another instance.",
        ),
        TryLockError::Error(error) => error,
    }
}

fn validate_lock(file: &File) -> io::Result<()> {
    let info = inspect(file)?;
    if !info.is_file() || !info.single_link() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The deployment lock must be an ordinary file with a single link.",
        ));
    }
    Ok(())
}

fn lock_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_fs_ext::OpenOptionsSyncExt;
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600).nonblock(true);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        // Share access so another backend can reach the actual lock check, but
        // prevent deleting/renaming the held file. inspect rejects every reparse
        // point, including non-symlink tags. The parent directory's ACL applies.
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
}

fn open_or_create_data(path: &Path) -> io::Result<Dir> {
    match open_root(path) {
        Ok(directory) => return Ok(directory),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid deployment data directory.",
        )
    })?;
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = open_or_create_data(parent)?;
    create_child(&parent, Path::new(name))
}

fn create_child(parent: &Dir, name: &Path) -> io::Result<Dir> {
    let builder = DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use cap_std::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    // On Windows creation inherits the existing user data directory's ACL;
    // Unix mode bits are not a substitute for a Windows ACL policy.
    match parent.create_dir_with(name, &builder) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let directory = parent.open_dir_nofollow(name)?.into_std_file();
    if !inspect(&directory)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Deployment data must use ordinary directories.",
        ));
    }
    Ok(Dir::from_std_file(directory))
}

#[cfg(test)]
#[path = "deployment_lock_tests.rs"]
mod tests;
