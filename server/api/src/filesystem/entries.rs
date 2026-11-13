use super::component;
use cap_fs_ext::MetadataExt;
use cap_std::fs::Dir;
use std::io;

/// Listable entry kind, without following links or opening file contents.
pub fn directory_entry(parent: &Dir, name: &str) -> io::Result<Option<bool>> {
    if component(name).is_err() {
        return Ok(None);
    }
    let meta = parent.symlink_metadata(name)?;
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(None);
        }
    }
    if meta.is_dir() {
        Ok(Some(true))
    } else if meta.is_file() && meta.nlink() == 1 {
        Ok(Some(false))
    } else {
        Ok(None)
    }
}
