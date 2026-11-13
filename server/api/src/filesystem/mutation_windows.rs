use super::Removal;
use cap_std::fs::Dir;
use std::{
    fs::File,
    io,
    mem::{offset_of, size_of},
    os::windows::io::AsRawHandle,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_DISPOSITION_INFO, FILE_INFO_BY_HANDLE_CLASS, FILE_RENAME_INFO, FileDispositionInfo,
    FileRenameInfo, SetFileInformationByHandle,
};

fn set(
    file: &File,
    class: FILE_INFO_BY_HANDLE_CLASS,
    value: *const std::ffi::c_void,
    size: u32,
) -> io::Result<()> {
    if unsafe { SetFileInformationByHandle(file.as_raw_handle() as _, class, value, size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn rename_unique(
    _from: &Dir,
    _source: &str,
    file: &File,
    to: &Dir,
    target: &str,
) -> io::Result<()> {
    let wide: Vec<u16> = target.encode_utf16().collect();
    let bytes = wide
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(too_long)?;
    let length = u32::try_from(bytes).map_err(|_| too_long())?;
    let size = offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(bytes)
        .and_then(|size| size.checked_add(size_of::<u16>()))
        .ok_or_else(too_long)?
        .max(size_of::<FILE_RENAME_INFO>());
    let buffer_size = u32::try_from(size).map_err(|_| too_long())?;
    // usize alignment covers the native HANDLE and union. Zeroed trailing space
    // supplies a terminator without including it in the byte-counted filename.
    let mut buffer = vec![0usize; size.div_ceil(size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = to.as_raw_handle() as _;
        (*info).FileNameLength = length;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            wide.len(),
        );
    }
    // Relative FileName + RootDirectory is the documented Win32 contract:
    // https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info
    set(file, FileRenameInfo, info.cast(), buffer_size)
}

fn too_long() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "Filename is too long.")
}

pub(super) fn remove_matching(_parent: &Dir, _source: &str, file: &File) -> io::Result<Removal> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    set(
        file,
        FileDispositionInfo,
        (&info as *const FILE_DISPOSITION_INFO).cast(),
        size_of::<FILE_DISPOSITION_INFO>() as u32,
    )?;
    // No readonly/ACL changes, POSIX assumptions or path-based fallback. The
    // object stays open, and callers retain ownership until transaction cleanup.
    Ok(Removal::DeleteOnClose)
}
