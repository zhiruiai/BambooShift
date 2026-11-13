use crate::{
    error::{ApiError, Result},
    filesystem::{self, FileStamp},
};
use cap_std::fs::Dir;
use std::{
    fs::File,
    io::{Read, Write},
    path::{Component, Path},
};
const LIMIT: usize = 10 * 1024 * 1024;

pub struct Directory(pub(super) Dir);
pub struct ReadFile {
    _parent: Directory,
    file: File,
    initial: FileStamp,
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
pub(super) fn io_failure(error: std::io::Error) -> ApiError {
    if error.kind() == std::io::ErrorKind::NotFound {
        ApiError::new(404, "文件不存在。").with_code("FILE_NOT_FOUND")
    } else {
        failure()
    }
}
pub(super) fn regular(file: &File) -> Result<FileStamp> {
    let info = filesystem::inspect(file).map_err(io_failure)?;
    if !info.is_file() || !info.single_link() {
        return Err(failure());
    }
    Ok(info)
}
pub(super) fn same(a: &FileStamp, b: &FileStamp) -> bool {
    a == b && b.single_link()
}
impl Directory {
    pub fn open(directory: &Path, create: bool) -> Result<Self> {
        let parent = filesystem::open_root(directory).map_err(|_| failure())?;
        let workspace = if create {
            filesystem::create_dir(&parent, "workspace")
        } else {
            filesystem::open_dir(&parent, "workspace")
        };
        Ok(Self(workspace.map_err(io_failure)?))
    }
    pub(super) fn parent(&self, name: &str) -> Result<(Directory, String)> {
        if name.is_empty() || name.len() > 4096 || name.contains(['\\', '\0']) {
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
            parent = Directory(filesystem::open_dir(&parent.0, component).map_err(io_failure)?);
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
        // Acquire rollback ownership before the first filesystem mutation.
        let parent = Directory(self.0.try_clone()?);
        let mut selected = name.to_owned();
        for attempt in 0..2 {
            match filesystem::create_file(&self.0, &selected) {
                Ok(file) => {
                    let mut upload = Uploaded {
                        parent,
                        name: selected.clone(),
                        file,
                        committed: false,
                    };
                    upload.file.write_all(bytes)?;
                    upload.file.sync_all()?;
                    regular(&upload.file)?;
                    return Ok((selected, upload));
                }
                Err(error) if attempt == 0 && error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let prefix = id.get(..8).ok_or_else(failure)?;
                    selected = format!("{prefix}-{name}");
                }
                Err(error) => return Err(io_failure(error)),
            }
        }
        Err(failure())
    }
    pub fn reader(&self, name: &str) -> Result<ReadFile> {
        let (parent, name) = self.parent(name)?;
        let file = filesystem::open_file(&parent.0, &name).map_err(io_failure)?;
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
        let file = filesystem::open_for_change(&parent.0, &original).map_err(io_failure)?;
        let before = regular(&file)?;
        let temporary = format!(".openbot-delete-{}", uuid::Uuid::new_v4());
        let root = Directory(self.0.try_clone()?);
        rename_unique(&parent.0, &original, &file, &self.0, &temporary)?;
        let removed = Removed {
            root,
            parent,
            original,
            temporary,
            file,
            committed: false,
        };
        let staged =
            filesystem::open_file(&removed.root.0, &removed.temporary).map_err(io_failure)?;
        if !before.same_identity(&regular(&staged)?) {
            return Err(failure());
        }
        Ok(removed)
    }
}
impl ReadFile {
    pub(crate) fn snapshot(&self) -> Result<FileStamp> {
        let meta = regular(&self.file)?;
        if !same(&self.initial, &meta) {
            return Err(failure());
        }
        Ok(meta)
    }
    pub(crate) fn stamp(&self) -> Result<String> {
        Ok(self.snapshot()?.version_key())
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
                &self.file,
                &self.parent.0,
                &self.original,
            );
        }
    }
}
pub(super) fn unlink_matching(parent: &Dir, name: &str, file: &File) -> bool {
    // Windows may defer removal until retained handles close. Callers only use
    // this for final cleanup, never to make a rollback destination available.
    filesystem::remove_matching(parent, name, file).is_ok()
}
pub(super) fn rename_unique(
    from: &Dir,
    name: &str,
    file: &File,
    to: &Dir,
    target: &str,
) -> Result<()> {
    filesystem::rename_unique(from, name, file, to, target).map_err(io_failure)
}

#[cfg(test)]
#[path = "file_storage_tests.rs"]
mod tests;
