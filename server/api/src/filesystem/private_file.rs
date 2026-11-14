//! Atomic replacement of service-owned private configuration, not workspace files.
//!
//! The operator selects the parent path. We reject a redirected final directory
//! with the existing filesystem boundary, and create temporary files beside the
//! destination (never in a shared system temporary directory). Unix directory
//! names can still be changed by another process with the same filesystem rights;
//! this is not a capability-relative workspace mutation API.

use std::{fs::File, io, io::Write, path::Path};

#[derive(Debug, PartialEq)]
enum DirectorySync {
    #[cfg(unix)]
    Confirmed,
    #[cfg(not(unix))]
    Unsupported,
    Unconfirmed(io::ErrorKind),
}

/// An error means the new document was not published. Once replacement succeeds,
/// callers must commit the matching database reference / in-memory state even if
/// the filesystem cannot confirm directory durability. Such failures are logged
/// without paths or document contents, never reported as an uncommitted write.
///
/// Contents are synchronized before replacement. On Windows, files inherit the
/// configured directory's ACL; this does not establish an owner-only Windows ACL
/// or promise Unix directory-fsync semantics.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let durability = publish(
        path,
        |file| {
            file.write_all(bytes)?;
            file.sync_all()
        },
        sync_directory,
    )?;
    if let DirectorySync::Unconfirmed(kind) = durability {
        let _ = writeln!(
            io::stderr().lock(),
            "Private configuration published; directory durability could not be confirmed ({kind:?})."
        );
    }
    Ok(())
}

fn publish(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
    sync: impl FnOnce(&File) -> io::Result<DirectorySync>,
) -> io::Result<DirectorySync> {
    let directory = path.parent().ok_or_else(super::invalid)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(super::invalid)?;
    super::component(name)?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    let parent = super::open_root(directory)?.into_std_file();
    let mut temporary = tempfile::Builder::new()
        .prefix(".private-")
        .rand_bytes(16)
        .tempfile_in(directory)?;
    write(temporary.as_file_mut())?;
    // tempfile owns pre-publication cleanup and implements replacement on both
    // Unix and Windows. Drop the returned handle after a successful publication.
    drop(temporary.persist(path).map_err(|error| error.error)?);
    // This is past the commit point: no ordinary error or destructive rollback.
    Ok(sync(&parent).unwrap_or_else(|error| DirectorySync::Unconfirmed(error.kind())))
}

fn sync_directory(directory: &File) -> io::Result<DirectorySync> {
    #[cfg(unix)]
    {
        directory.sync_all()?;
        Ok(DirectorySync::Confirmed)
    }
    #[cfg(not(unix))]
    {
        // A Windows directory opened for metadata is not a writable file handle
        // accepted by FlushFileBuffers. File contents were already synchronized.
        let _ = directory;
        Ok(DirectorySync::Unsupported)
    }
}

#[cfg(test)]
#[path = "private_file_tests.rs"]
mod tests;
