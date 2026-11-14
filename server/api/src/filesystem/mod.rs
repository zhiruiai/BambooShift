//! Handle-relative filesystem operations shared by the backend and its launcher.
//!
//! The configured root is an ambient authority boundary. Its ancestors are
//! selected by the operator; its final component and every child opened here
//! must be ordinary objects, never symbolic links or Windows reparse points.

mod metadata;
pub use metadata::{FileStamp, inspect, inspect_entry};
mod entries;
pub use entries::directory_entry;
mod mutation;
pub use mutation::{Removal, remove_matching, rename_unique};
mod writable;
pub use writable::{create_dir, create_file, open_for_change};
mod private_file;
pub use private_file::write_private;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    fs::File,
    io,
    path::{Component, Path, PathBuf},
};

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "Expected one ordinary filesystem component.",
    )
}

/// Reject aliases, streams and device names consistently on every platform.
fn component(name: &str) -> io::Result<()> {
    let mut parts = Path::new(name).components();
    if name.is_empty()
        || name.contains(['/', '\\', '\0', ':'])
        || name.ends_with(['.', ' '])
        || !matches!(parts.next(), Some(Component::Normal(_)))
        || parts.next().is_some()
    {
        return Err(invalid());
    }
    let stem = name.split('.').next().unwrap().to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        return Err(invalid());
    }
    Ok(())
}

fn directory(file: File) -> io::Result<Dir> {
    if !inspect(&file)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "Expected a directory.",
        ));
    }
    Ok(Dir::from_std_file(file))
}

/// Open an existing configured root without following its final component.
pub fn open_root(path: &Path) -> io::Result<Dir> {
    // Remove trailing separators/dots before opening: on POSIX `link/` can
    // follow a symlink despite O_NOFOLLOW. Parent traversal is not a root API.
    if path.as_os_str().is_empty() || path.components().any(|c| c == Component::ParentDir) {
        return Err(invalid());
    }
    let normalized: PathBuf = path.components().collect();
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };
        // Keep the selected directory from being renamed/replaced while held.
        options
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    directory(options.open(normalized)?)
}

/// Open exactly one child directory relative to the retained parent handle.
pub fn open_dir(parent: &Dir, name: &str) -> io::Result<Dir> {
    component(name)?;
    directory(parent.open_dir_nofollow(name)?.into_std_file())
}

/// Open an ordinary read-only file without following links or blocking on FIFOs.
pub fn open_file(parent: &Dir, name: &str) -> io::Result<File> {
    component(name)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = parent.open_with(name, &options)?.into_std();
    if !inspect(&file)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Expected an ordinary file.",
        ));
    }
    Ok(file)
}

#[cfg(test)]
mod tests;
