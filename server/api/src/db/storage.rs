//! Checks around pathname-based SQLite connections, not a replacement SQLite VFS.
//!
//! Directory handles keep Windows names stable. Unix checks must never open and
//! close the database just to read metadata: that can release this process's
//! SQLite advisory locks. Private deployment directories remain a requirement.

use crate::{error::Result, filesystem as fs};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    io,
    path::{Path, PathBuf},
};

pub(crate) struct DatabaseFiles {
    root: PathBuf,
    parents: Vec<String>,
    // Retain the whole directory chain while a source connection is in use.
    directories: Vec<Dir>,
    identities: Vec<fs::FileStamp>,
    path: PathBuf,
    name: String,
    main: fs::FileStamp,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Database storage is unavailable.",
    )
}

fn entry(parent: &Dir, name: &str, missing: bool) -> io::Result<Option<fs::FileStamp>> {
    match fs::inspect_entry(parent, name) {
        Ok(stamp) if stamp.is_file() && stamp.single_link() => Ok(Some(stamp)),
        Err(e) if missing && e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
        _ => Err(invalid()),
    }
}

fn sidecars(parent: &Dir, name: &str) -> io::Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        entry(parent, &format!("{name}{suffix}"), true)?;
    }
    Ok(())
}

fn directory_stamp(directory: &Dir) -> io::Result<fs::FileStamp> {
    let stamp = fs::inspect(&directory.try_clone()?.into_std_file())?;
    if !stamp.is_dir() {
        return Err(invalid());
    }
    Ok(stamp)
}

fn walk(root: &Path, parents: &[String]) -> io::Result<Vec<Dir>> {
    let mut directories = vec![fs::open_root(root)?];
    for name in parents {
        let child = fs::open_dir(directories.last().unwrap(), name)?;
        directories.push(child);
    }
    Ok(directories)
}

/// Exclusively create only the missing main database; never open an existing one
/// for inspection or hold a transaction/DELETE handle while SQLite is connected.
fn create(parent: &Dir, name: &str) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    match parent.open_with(name, &options) {
        Ok(file) => drop(file), // Must close before establishing any SQLite lock.
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    Ok(())
}

impl DatabaseFiles {
    pub(crate) fn prepare(root: &Path, parents: &[&str], name: &str) -> Result<Self> {
        let files = Self::load(root, parents, name, true)?;
        super::private_file(files.path())?;
        files.check()?;
        Ok(files)
    }

    /// Open a source description without creating directories, databases or tables.
    pub(crate) fn open(root: &Path, parents: &[&str], name: &str) -> Result<Self> {
        Self::load(root, parents, name, false)
    }

    fn load(root: &Path, parents: &[&str], name: &str, initialize: bool) -> Result<Self> {
        let parents: Vec<String> = parents.iter().map(|part| (*part).to_owned()).collect();
        let directories = walk(root, &parents)?;
        let identities = directories
            .iter()
            .map(directory_stamp)
            .collect::<io::Result<Vec<_>>>()?;
        let parent = directories.last().unwrap();
        let main = entry(parent, name, initialize)?;
        sidecars(parent, name)?;
        let main = match main {
            Some(main) => main,
            None => {
                create(parent, name)?;
                entry(parent, name, false)?.ok_or_else(invalid)?
            }
        };
        let mut path = root.to_owned();
        for part in &parents {
            path.push(part);
        }
        path.push(name);
        let files = Self {
            root: root.to_owned(),
            parents,
            directories,
            identities,
            path,
            name: name.to_owned(),
            main,
        };
        files.check()?;
        Ok(files)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn directory(&self) -> &Path {
        self.path.parent().unwrap()
    }

    pub(crate) fn check(&self) -> Result<()> {
        // Re-walk the currently named chain. Inspecting only retained handles
        // would miss a replaced directory on systems that permit renaming it.
        let current = walk(&self.root, &self.parents)?;
        for (directory, before) in current.iter().zip(&self.identities) {
            if !directory_stamp(directory)?.same_identity(before) {
                return Err(invalid().into());
            }
        }
        let parent = current.last().unwrap();
        let main = entry(parent, &self.name, false)?.ok_or_else(invalid)?;
        if !main.same_identity(&self.main) {
            return Err(invalid().into());
        }
        sidecars(parent, &self.name)?;
        debug_assert_eq!(self.directories.len(), current.len());
        Ok(())
    }
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
