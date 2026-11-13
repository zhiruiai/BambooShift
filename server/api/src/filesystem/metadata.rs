//! Identity and change information from handles or non-following entry queries.
//!
//! A stamp is a change detector, not a content digest. Callers still check it
//! before and after I/O and must open paths through the filesystem boundary.

use cap_std::fs::Dir;
use std::{fs::File, io};

#[cfg(unix)]
#[path = "metadata_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "metadata_windows.rs"]
mod platform;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Identity {
    volume: u64,
    object: [u8; 16],
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Kind {
    File,
    Directory,
    #[cfg(unix)]
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Version {
    #[cfg(unix)]
    Unix {
        mode: u32,
        modified_seconds: i64,
        modified_nanos: i64,
        changed_seconds: i64,
        changed_nanos: i64,
    },
    #[cfg(windows)]
    Windows {
        attributes: u32,
        modified_ticks: i64,
        changed_ticks: i64,
        delete_pending: bool,
    },
}

/// A complete platform-specific snapshot of identity and relevant metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileStamp {
    identity: Identity,
    kind: Kind,
    length: u64,
    links: u64,
    version: Version,
}

impl FileStamp {
    pub fn len(&self) -> u64 {
        self.length
    }

    pub fn is_empty(&self) -> bool {
        self.length == 0
    }

    pub fn is_file(&self) -> bool {
        self.kind == Kind::File
    }

    pub fn is_dir(&self) -> bool {
        self.kind == Kind::Directory
    }

    pub fn single_link(&self) -> bool {
        self.links == 1
    }

    /// Compare object identities independently of content or metadata changes.
    pub fn same_identity(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    /// An opaque change key, scoped to this platform and filesystem object.
    pub fn version_key(&self) -> String {
        match self.version {
            #[cfg(unix)]
            Version::Unix {
                mode,
                modified_seconds,
                modified_nanos,
                changed_seconds,
                changed_nanos,
            } => {
                let inode = u64::from_le_bytes(self.identity.object[..8].try_into().unwrap());
                format!(
                    "{}:{inode}:{mode}:{}:{}:{modified_seconds}:{modified_nanos}:{changed_seconds}:{changed_nanos}",
                    self.identity.volume, self.links, self.length
                )
            }
            #[cfg(windows)]
            Version::Windows {
                attributes,
                modified_ticks,
                changed_ticks,
                delete_pending,
            } => {
                use std::fmt::Write;
                let mut object = String::with_capacity(32);
                for byte in self.identity.object {
                    write!(&mut object, "{byte:02x}").unwrap();
                }
                format!(
                    "win:{}:{object}:{attributes}:{}:{}:{modified_ticks}:{changed_ticks}:{delete_pending}",
                    self.identity.volume, self.links, self.length
                )
            }
        }
    }
}

/// Inspect only the supplied handle; no path lookup or weaker identity fallback.
pub fn inspect(file: &File) -> io::Result<FileStamp> {
    platform::inspect(file)
}

/// Inspect one child without following links or acquiring mutation authority.
///
/// Unix uses a metadata query without opening or closing the target file: an
/// unrelated close of a live SQLite file can release this process's POSIX locks.
/// Windows uses a short-lived attribute handle with read/write/delete sharing.
/// The result is a snapshot, not a retained entry or a replacement for SQLite's
/// own locking. Callers decide whether files, directories or multiple links are
/// permitted, and must recheck identity around their own operations.
pub fn inspect_entry(parent: &Dir, name: &str) -> io::Result<FileStamp> {
    super::component(name)?;
    platform::inspect_entry(parent, name)
}

#[cfg(test)]
#[path = "metadata_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "metadata_entry_tests.rs"]
mod entry_tests;
