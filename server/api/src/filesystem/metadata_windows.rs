use super::{FileStamp, Identity, Kind, Version};
use std::{fs::File, io, mem::MaybeUninit, os::windows::io::AsRawHandle};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS,
    FILE_STANDARD_INFO, FILE_TYPE_DISK, FileBasicInfo, FileIdInfo, FileStandardInfo,
    GetFileInformationByHandleEx, GetFileType,
};

// Each call below pairs one Windows information class with its documented POD
// result structure. A failed query never exposes an uninitialized result.
fn query<T>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS) -> io::Result<T> {
    let mut output = MaybeUninit::<T>::zeroed();
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as _,
            class,
            output.as_mut_ptr().cast(),
            std::mem::size_of::<T>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { output.assume_init() })
}

pub(super) fn inspect(file: &File) -> io::Result<FileStamp> {
    if unsafe { GetFileType(file.as_raw_handle() as _) } != FILE_TYPE_DISK {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "A stable filesystem identity requires a disk file or directory.",
        ));
    }
    let basic: FILE_BASIC_INFO = query(file, FileBasicInfo)?;
    if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Reparse points are not permitted in managed storage.",
        ));
    }
    let identity: FILE_ID_INFO = query(file, FileIdInfo)?;
    let standard: FILE_STANDARD_INFO = query(file, FileStandardInfo)?;
    let length = u64::try_from(standard.EndOfFile).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid filesystem object length.",
        )
    })?;
    Ok(FileStamp {
        identity: Identity {
            volume: identity.VolumeSerialNumber,
            object: identity.FileId.Identifier,
        },
        kind: if standard.Directory {
            Kind::Directory
        } else {
            Kind::File
        },
        length,
        links: standard.NumberOfLinks.into(),
        version: Version::Windows {
            attributes: basic.FileAttributes,
            modified_ticks: basic.LastWriteTime,
            changed_ticks: basic.ChangeTime,
            delete_pending: standard.DeletePending,
        },
    })
}
