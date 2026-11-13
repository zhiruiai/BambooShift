use super::Removal;
use cap_std::fs::Dir;
use std::{ffi::CString, fs::File, io, os::fd::AsRawFd};

fn name(value: &str) -> io::Result<CString> {
    CString::new(value)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid filename."))
}

fn checked(result: libc::c_int) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn rename_unique(
    from: &Dir,
    source: &str,
    _file: &File,
    to: &Dir,
    target: &str,
) -> io::Result<()> {
    let source = name(source)?;
    let target = name(target)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            from.as_raw_fd(),
            source.as_ptr(),
            to.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            from.as_raw_fd(),
            source.as_ptr(),
            to.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return checked(result);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Atomic no-replace rename is unavailable on this platform.",
    ))
}

pub(super) fn remove_matching(parent: &Dir, source: &str, _file: &File) -> io::Result<Removal> {
    let source = name(source)?;
    checked(unsafe { libc::unlinkat(parent.as_raw_fd(), source.as_ptr(), 0) })?;
    Ok(Removal::Unlinked)
}
