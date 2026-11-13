use super::{FileStamp, Identity, Kind, Version};
use std::{fs::File, io, os::unix::fs::MetadataExt};

pub(super) fn inspect(file: &File) -> io::Result<FileStamp> {
    let info = file.metadata()?;
    let mut object = [0; 16];
    object[..8].copy_from_slice(&info.ino().to_le_bytes());
    Ok(FileStamp {
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
    })
}
