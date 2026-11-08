use super::file_storage::{
    Directory, c_name, failure, open_at, regular, rename_unique, same, unlink_matching,
};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    ffi::CStr,
    fs::File,
    io::{Read, Seek, Write},
    os::{
        fd::{AsRawFd, IntoRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path},
};

pub(crate) const TEXT_LIMIT: usize = 4 * 1024 * 1024;
pub(crate) struct Edit {
    parent: Directory,
    name: String,
    temporary: String,
    backup: String,
    file: File,
    previous: Option<File>,
    previous_stamp: Option<std::fs::Metadata>,
    published: bool,
    committed: bool,
}
pub(crate) fn path(value: &str) -> Result<String> {
    if value.is_empty() || value.len() > 4096 || value.contains(['\0', '\\']) {
        return Err(failure());
    }
    let parts = Path::new(value)
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .map(|part| match part {
            Component::Normal(part) => part
                .to_str()
                .filter(|p| !p.starts_with(".openbot-"))
                .map(str::to_owned)
                .ok_or_else(failure),
            _ => Err(failure()),
        })
        .collect::<Result<Vec<_>>>()?;
    if parts.is_empty() || parts.len() > 128 {
        return Err(failure());
    }
    Ok(parts.join("/"))
}
pub(crate) fn decode(bytes: &[u8], name: &str) -> Result<String> {
    if bytes.len() > TEXT_LIMIT {
        return Err(ApiError::new(413, "文本文件最多 4 MiB。"));
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if bytes.contains(&0)
        || [
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "png", "jpg", "jpeg", "gif",
            "webp", "zip", "gz", "woff", "woff2", "mp3", "mp4",
        ]
        .contains(&ext.as_str())
    {
        return Err(ApiError::bad(
            "增量修改只支持 UTF-8 文本，不能修改二进制附件。",
        ));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| ApiError::bad("文件不是有效的 UTF-8 文本。"))
}
impl Directory {
    pub(crate) fn list(&self, requested: &str) -> Result<Vec<Value>> {
        let directory = if requested == "." || requested.is_empty() {
            Directory(self.0.try_clone()?)
        } else {
            let normalized = path(requested)?;
            let (parent, name) = self.parent(&normalized)?;
            Directory(open_at(
                &parent.0,
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?)
        };
        // fdopendir owns this duplicate and closedir releases it on every exit.
        let fd = directory.0.try_clone()?.into_raw_fd();
        let raw = unsafe { libc::fdopendir(fd) };
        if raw.is_null() {
            unsafe { libc::close(fd) };
            return Err(failure());
        }
        struct Entries(*mut libc::DIR);
        impl Drop for Entries {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let entries = Entries(raw);
        let mut output = Vec::new();
        loop {
            let item = unsafe { libc::readdir(entries.0) };
            if item.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) }
                .to_str()
                .map_err(|_| failure())?;
            if name == "." || name == ".." || name.starts_with(".openbot-") {
                continue;
            }
            let cname = c_name(name)?;
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    directory.0.as_raw_fd(),
                    cname.as_ptr(),
                    &mut stat,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(failure());
            }
            let kind = stat.st_mode & libc::S_IFMT;
            if kind != libc::S_IFDIR && (kind != libc::S_IFREG || stat.st_nlink != 1) {
                continue;
            }
            output.push(json!({"name":name,"directory":kind==libc::S_IFDIR}));
            if output.len() > 1000 {
                return Err(ApiError::new(
                    413,
                    "此目录项目超过 1000 个，请读取更具体的子目录。",
                ));
            }
        }
        output.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(output)
    }
    pub(crate) fn edit(&self, requested: &str, create_parents: bool) -> Result<Edit> {
        let normalized = path(requested)?;
        let parts = normalized.split('/').collect::<Vec<_>>();
        let mut parent = Directory(self.0.try_clone()?);
        for part in &parts[..parts.len() - 1] {
            if create_parents {
                let name = c_name(part)?;
                let result = unsafe { libc::mkdirat(parent.0.as_raw_fd(), name.as_ptr(), 0o700) };
                if result != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(failure());
                }
            }
            parent = Directory(open_at(
                &parent.0,
                part,
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?);
        }
        let name = parts.last().unwrap().to_string();
        let previous = match open_at(&parent.0, &name, libc::O_RDONLY) {
            Ok(file) => Some(file),
            Err(e) if e.code == "FILE_NOT_FOUND" => None,
            Err(e) => return Err(e),
        };
        let previous_stamp = previous.as_ref().map(regular).transpose()?;
        if previous_stamp
            .as_ref()
            .is_some_and(|m| m.len() > TEXT_LIMIT as u64)
        {
            return Err(ApiError::new(413, "文本文件最多 4 MiB。"));
        }
        let temporary = format!(".openbot-edit-{}", uuid::Uuid::new_v4());
        let file = open_at(
            &parent.0,
            &temporary,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        )?;
        Ok(Edit {
            parent,
            name,
            temporary,
            backup: format!(".openbot-backup-{}", uuid::Uuid::new_v4()),
            file,
            previous,
            previous_stamp,
            published: false,
            committed: false,
        })
    }
}
impl Edit {
    pub(crate) fn previous(&mut self) -> Result<Option<Vec<u8>>> {
        let Some(file) = self.previous.as_mut() else {
            return Ok(None);
        };
        let before = self.previous_stamp.as_ref().unwrap();
        if !same(before, &regular(file)?) {
            return Err(failure());
        }
        file.rewind()?;
        let mut bytes = Vec::new();
        file.take(TEXT_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() != before.len() as usize || !same(before, &regular(file)?) {
            return Err(failure());
        }
        Ok(Some(bytes))
    }
    pub(crate) fn stage(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > TEXT_LIMIT {
            return Err(ApiError::new(413, "文本文件最多 4 MiB。"));
        }
        self.file.write_all(bytes)?;
        self.file.sync_all()?;
        Ok(())
    }
    pub(crate) fn publish(&mut self) -> Result<()> {
        if let Some(previous) = &self.previous {
            let selected = open_at(&self.parent.0, &self.name, libc::O_RDONLY)?;
            let stamp = self.previous_stamp.as_ref().unwrap();
            if !same(stamp, &regular(previous)?) || !same(stamp, &regular(&selected)?) {
                return Err(failure());
            }
            rename_unique(&self.parent.0, &self.name, &self.parent.0, &self.backup)?;
            let moved = open_at(&self.parent.0, &self.backup, libc::O_RDONLY)?;
            let moved = regular(&moved)?;
            if moved.dev() != stamp.dev() || moved.ino() != stamp.ino() {
                let _ = rename_unique(&self.parent.0, &self.backup, &self.parent.0, &self.name);
                return Err(failure());
            }
        }
        rename_unique(&self.parent.0, &self.temporary, &self.parent.0, &self.name)?;
        self.published = true;
        Ok(())
    }
    pub(crate) fn commit(mut self) {
        self.committed = true;
        if let Some(previous) = &self.previous {
            unlink_matching(&self.parent.0, &self.backup, previous);
        }
    }
}
impl Drop for Edit {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if self.published {
            unlink_matching(&self.parent.0, &self.name, &self.file);
        }
        let _ = self.file.set_len(0);
        let _ = self.file.sync_all();
        unlink_matching(&self.parent.0, &self.temporary, &self.file);
        if let Some(previous) = &self.previous {
            if let Ok(file) = open_at(&self.parent.0, &self.backup, libc::O_RDONLY) {
                if let (Ok(a), Ok(b)) = (regular(previous), regular(&file)) {
                    if a.dev() == b.dev() && a.ino() == b.ino() {
                        let _ =
                            rename_unique(&self.parent.0, &self.backup, &self.parent.0, &self.name);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "file_edits_tests.rs"]
mod tests;
