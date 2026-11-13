use super::{component, inspect, open_dir};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use std::{fs::File, io};

pub fn create_dir(parent: &Dir, name: &str) -> io::Result<Dir> {
    component(name)?;
    let builder = DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use cap_std::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    match parent.create_dir_with(name, &builder) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    open_dir(parent, name)
}

/// Open an existing ordinary file for a transactional rename or deletion.
/// Windows DELETE access is requested only by mutation callers, never readers.
pub fn open_for_change(parent: &Dir, name: &str) -> io::Result<File> {
    open(parent, name, false)
}

/// Exclusively create a read/write transaction file; never truncate a collision.
pub fn create_file(parent: &Dir, name: &str) -> io::Result<File> {
    open(parent, name, true)
}

fn open(parent: &Dir, name: &str, create: bool) -> io::Result<File> {
    component(name)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    if create {
        options.write(true).create_new(true);
    }
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
            DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .access_mode(FILE_GENERIC_READ | DELETE | if create { FILE_GENERIC_WRITE } else { 0 })
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = parent.open_with(name, &options)?.into_std();
    let stamp = inspect(&file)?;
    if !stamp.is_file() || !stamp.single_link() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected an ordinary single-link file.",
        ));
    }
    Ok(file)
}
