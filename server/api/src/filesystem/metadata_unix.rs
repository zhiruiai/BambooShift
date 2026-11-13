use super::{FileStamp, Identity, Kind, Version};
use cap_std::fs::{Dir, Metadata, MetadataExt};
use std::{fs::File, io};

pub(super) fn inspect(file: &File) -> io::Result<FileStamp> {
    Ok(stamp(&Metadata::from_just_metadata(file.metadata()?)))
}

pub(super) fn inspect_entry(parent: &Dir, name: &str) -> io::Result<FileStamp> {
    // cap-std 4.0.3 routes single-component symlink_metadata through
    // stat_unchecked: statx/statat with SYMLINK_NOFOLLOW, never open(target).
    let info = parent.symlink_metadata(name)?;
    if info.is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Symbolic links are not permitted in managed storage.",
        ));
    }
    Ok(stamp(&info))
}

fn stamp(info: &Metadata) -> FileStamp {
    let mut object = [0; 16];
    object[..8].copy_from_slice(&info.ino().to_le_bytes());
    FileStamp {
        identity: Identity {
            volume: info.dev(),
            object,
        },
        kind: if info.is_file() {
            Kind::File
        } else if info.is_dir() {
            Kind::Directory
        } else {
            Kind::Other
        },
        length: info.len(),
        links: info.nlink(),
        version: Version::Unix {
            mode: info.mode(),
            modified_seconds: info.mtime(),
            modified_nanos: info.mtime_nsec(),
            changed_seconds: info.ctime(),
            changed_nanos: info.ctime_nsec(),
        },
    }
}
