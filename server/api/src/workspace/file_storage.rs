use crate::error::{ApiError, Result};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};
const LIMIT: usize = 10 * 1024 * 1024;

pub struct Directory(pub(super) File);
pub struct ReadFile {
    _parent: Directory,
    file: File,
    initial: std::fs::Metadata,
    remaining: u64,
}
pub struct Uploaded {
    parent: Directory,
    name: String,
    file: File,
    committed: bool,
}
pub struct Removed {
    root: Directory,
    parent: Directory,
    original: String,
    temporary: String,
    file: File,
    committed: bool,
}
pub(super) fn failure() -> ApiError {
    ApiError::new(409, "文件路径或内容已变化，请刷新后重试。")
}
pub(super) fn c_name(name: &str) -> Result<CString> {
    CString::new(name).map_err(|_| failure())
}
pub(super) fn regular(file: &File) -> Result<std::fs::Metadata> {
    let info = file.metadata()?;
    if !info.is_file() || info.nlink() != 1 {
        return Err(failure());
    }
    Ok(info)
}
pub(super) fn same(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
        && b.nlink() == 1
}
pub(super) fn open_at(parent: &File, name: &str, flags: i32) -> Result<File> {
    let name = c_name(name)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            return Err(ApiError::new(404, "文件不存在。").with_code("FILE_NOT_FOUND"));
        }
        return Err(failure());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
impl Directory {
    pub fn open(directory: &Path, create: bool) -> Result<Self> {
        let path = CString::new(directory.as_os_str().as_bytes()).map_err(|_| failure())?;
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(failure());
        }
        let parent = unsafe { File::from_raw_fd(fd) };
        if create {
            let name = c_name("workspace")?;
            let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
            if result != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(failure());
            }
        }
        Ok(Self(open_at(
            &parent,
            "workspace",
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?))
    }
    pub(super) fn parent(&self, name: &str) -> Result<(Directory, String)> {
        if name.is_empty() || name.len() > 4096 || name.contains('\\') || name.contains('\0') {
            return Err(failure());
        }
        let parts = Path::new(name)
            .components()
            .map(|v| match v {
                Component::Normal(s) => s.to_str().map(str::to_owned).ok_or_else(failure),
                _ => Err(failure()),
            })
            .collect::<Result<Vec<_>>>()?;
        if parts.is_empty() || parts.len() > 128 {
            return Err(failure());
        }
        let mut parent = Directory(self.0.try_clone()?);
        for component in &parts[..parts.len() - 1] {
            parent = Directory(open_at(
                &parent.0,
                component,
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?);
        }
        Ok((parent, parts.last().unwrap().clone()))
    }
    pub fn upload(&self, name: &str, bytes: &[u8], id: &str) -> Result<(String, Uploaded)> {
        if bytes.len() > LIMIT
            || Path::new(name).file_name().and_then(|v| v.to_str()) != Some(name)
            || name == "."
            || name == ".."
            || name.contains('\\')
            || name.starts_with(".openbot-")
        {
            return Err(ApiError::bad("文件名称或大小无效。"));
        }
        let mut selected = name.to_owned();
        for attempt in 0..2 {
            let cname = c_name(&selected)?;
            let fd = unsafe {
                libc::openat(
                    self.0.as_raw_fd(),
                    cname.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd >= 0 {
                let mut upload = Uploaded {
                    parent: Directory(self.0.try_clone()?),
                    name: selected.clone(),
                    file: unsafe { File::from_raw_fd(fd) },
                    committed: false,
                };
                upload.file.write_all(bytes)?;
                upload.file.sync_all()?;
                regular(&upload.file)?;
                return Ok((selected, upload));
            }
            if attempt != 0
                || std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(failure());
            }
            selected = format!("{}-{name}", &id[..8]);
        }
        Err(failure())
    }
    pub fn reader(&self, name: &str) -> Result<ReadFile> {
        let (parent, name) = self.parent(name)?;
        let file = open_at(&parent.0, &name, libc::O_RDONLY)?;
        let initial = regular(&file)?;
        Ok(ReadFile {
            remaining: initial.len(),
            _parent: parent,
            file,
            initial,
        })
    }
    pub fn remove(&self, name: &str) -> Result<Removed> {
        let (parent, original) = self.parent(name)?;
        let file = open_at(&parent.0, &original, libc::O_RDONLY)?;
        let before = regular(&file)?;
        let temporary = format!(".openbot-delete-{}", uuid::Uuid::new_v4());
        rename_unique(&parent.0, &original, &self.0, &temporary)?;
        let removed = Removed {
            root: Directory(self.0.try_clone()?),
            parent,
            original,
            temporary,
            file,
            committed: false,
        };
        let staged = open_at(&removed.root.0, &removed.temporary, libc::O_RDONLY)?;
        let info = regular(&staged)?;
        if before.dev() != info.dev() || before.ino() != info.ino() {
            return Err(failure());
        }
        Ok(removed)
    }
}
impl ReadFile {
    pub(crate) fn stamp(&self) -> Result<String> {
        let meta = regular(&self.file)?;
        if !same(&self.initial, &meta) {
            return Err(failure());
        }
        Ok(format!(
            "{}:{}:{}:{}:{}:{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.mode(),
            meta.nlink(),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec()
        ))
    }
    pub fn len(&self) -> u64 {
        self.initial.len()
    }
    pub fn next(&mut self) -> Result<Option<Vec<u8>>> {
        if !same(&self.initial, &regular(&self.file)?) {
            return Err(failure());
        }
        if self.remaining == 0 {
            return Ok(None);
        }
        let mut bytes = vec![0; self.remaining.min(64 * 1024) as usize];
        self.file.read_exact(&mut bytes)?;
        if !same(&self.initial, &regular(&self.file)?) {
            return Err(failure());
        }
        self.remaining -= bytes.len() as u64;
        Ok(Some(bytes))
    }
}
impl Uploaded {
    pub fn commit(mut self) {
        self.committed = true;
    }
}
impl Drop for Uploaded {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.file.set_len(0);
            let _ = self.file.sync_all();
            unlink_matching(&self.parent.0, &self.name, &self.file);
        }
    }
}
impl Removed {
    pub fn commit(mut self) -> Result<()> {
        self.committed = true;
        if !unlink_matching(&self.root.0, &self.temporary, &self.file) {
            return Err(failure());
        }
        Ok(())
    }
}
impl Drop for Removed {
    fn drop(&mut self) {
        if !self.committed {
            let _ = rename_unique(
                &self.root.0,
                &self.temporary,
                &self.parent.0,
                &self.original,
            );
        }
    }
}
pub(super) fn unlink_matching(parent: &File, name: &str, file: &File) -> bool {
    let Ok(name) = c_name(name) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    let mut current: libc::stat = unsafe { std::mem::zeroed() };
    let found = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            &mut current,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if found != 0 || current.st_dev as u64 != meta.dev() || current.st_ino as u64 != meta.ino() {
        return false;
    }
    unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) == 0 }
}
pub(super) fn rename_unique(from: &File, name: &str, to: &File, target: &str) -> Result<()> {
    let name = c_name(name)?;
    let target = c_name(target)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            from.as_raw_fd(),
            name.as_ptr(),
            to.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            from.as_raw_fd(),
            name.as_ptr(),
            to.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(failure());
    }
    Ok(())
}

#[cfg(test)]
#[path = "file_storage_tests.rs"]
mod tests;
