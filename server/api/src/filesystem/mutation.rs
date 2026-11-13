//! Narrow, handle-relative mutations for managed workspace transactions.
//!
//! Parents must come from the managed filesystem boundary. Mutation files must
//! remain open throughout the transaction; on Windows use `open_for_change` or
//! `create_file`, which request DELETE access without sharing deletion.

use super::{component, inspect, open_file};
use cap_std::fs::Dir;
use std::{fs::File, io};

#[cfg(unix)]
#[path = "mutation_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "mutation_windows.rs"]
mod platform;

/// Whether removal finished now or was scheduled on the retained file handle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Removal {
    Unlinked,
    /// Windows may retain the name until all compatible readers have closed.
    /// Callers must not treat this as an immediately reusable destination name.
    DeleteOnClose,
}

fn changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "The named file no longer matches the retained single-link file.",
    )
}

fn directory(parent: &Dir) -> io::Result<()> {
    if !inspect(&parent.try_clone()?.into_std_file())?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "Expected a directory.",
        ));
    }
    Ok(())
}

fn matching(parent: &Dir, name: &str, file: &File) -> io::Result<()> {
    let held = inspect(file)?;
    if !held.is_file() || !held.single_link() {
        return Err(changed());
    }
    let current = inspect(&open_file(parent, name)?)?;
    if !current.is_file() || !current.single_link() || !held.same_identity(&current) {
        return Err(changed());
    }
    Ok(())
}

/// Rename without replacing any existing target, including links.
///
/// Windows mutates the retained file handle. Unix uses the native no-replace
/// rename after checking source identity; its source-name check is not atomic
/// with the rename against an external process mutating the same directory.
pub fn rename_unique(
    from: &Dir,
    name: &str,
    file: &File,
    to: &Dir,
    target: &str,
) -> io::Result<()> {
    component(name)?;
    component(target)?;
    directory(from)?;
    directory(to)?;
    matching(from, name, file)?;
    platform::rename_unique(from, name, file, to, target)
}

/// Remove only after checking that the current name identifies the held file.
///
/// Unix checks identity before unlinkat; this is not an atomic conditional
/// unlink. Windows marks the held object for deletion and returns DeleteOnClose.
/// Rollback must first rename a published file to a transaction-owned temporary
/// name before restoring its backup; it cannot restore over a pending deletion.
pub fn remove_matching(parent: &Dir, name: &str, file: &File) -> io::Result<Removal> {
    component(name)?;
    directory(parent)?;
    matching(parent, name, file)?;
    platform::remove_matching(parent, name, file)
}

#[cfg(test)]
#[path = "mutation_tests.rs"]
mod tests;
