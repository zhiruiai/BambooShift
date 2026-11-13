use super::file_storage::{
    Directory, failure, io_failure, regular, rename_unique, same, unlink_matching,
};
use crate::{
    error::{ApiError, Result},
    filesystem::{self, FileStamp},
};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Seek, Write},
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
    previous_stamp: Option<FileStamp>,
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
            Directory(filesystem::open_dir(&parent.0, &name).map_err(io_failure)?)
        };
        let mut output = Vec::new();
        for item in directory.0.entries().map_err(io_failure)? {
            let name = item.map_err(io_failure)?.file_name();
            let name = name.to_str().ok_or_else(failure)?;
            if name.starts_with(".openbot-") {
                continue;
            }
            let Some(is_directory) =
                filesystem::directory_entry(&directory.0, name).map_err(io_failure)?
            else {
                continue;
            };
            output.push(json!({"name":name,"directory":is_directory}));
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
            let child = if create_parents {
                filesystem::create_dir(&parent.0, part)
            } else {
                filesystem::open_dir(&parent.0, part)
            };
            parent = Directory(child.map_err(io_failure)?);
        }
        let name = parts.last().unwrap().to_string();
        let previous = match filesystem::open_for_change(&parent.0, &name).map_err(io_failure) {
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
        let file = filesystem::create_file(&parent.0, &temporary).map_err(io_failure)?;
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
        if self.published {
            return Err(failure());
        }
        if let Some(previous) = &self.previous {
            let selected = filesystem::open_file(&self.parent.0, &self.name).map_err(io_failure)?;
            let stamp = self.previous_stamp.as_ref().unwrap();
            if !same(stamp, &regular(previous)?) || !same(stamp, &regular(&selected)?) {
                return Err(failure());
            }
            rename_unique(
                &self.parent.0,
                &self.name,
                previous,
                &self.parent.0,
                &self.backup,
            )?;
            let moved = filesystem::open_file(&self.parent.0, &self.backup).map_err(io_failure)?;
            if !stamp.same_identity(&regular(&moved)?) {
                return Err(failure());
            }
        }
        rename_unique(
            &self.parent.0,
            &self.temporary,
            &self.file,
            &self.parent.0,
            &self.name,
        )?;
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
        let can_clean = if self.published {
            // Publication vacates the staging name, which another writer may
            // now own. Use a fresh name, and never clear a visible file if the
            // no-replace move fails. Windows deletion alone cannot free a name
            // while compatible readers still hold the object.
            let rollback = format!(".openbot-rollback-{}", uuid::Uuid::new_v4());
            if rename_unique(
                &self.parent.0,
                &self.name,
                &self.file,
                &self.parent.0,
                &rollback,
            )
            .is_ok()
            {
                self.temporary = rollback;
                true
            } else {
                false
            }
        } else {
            true
        };
        if can_clean {
            let _ = self.file.set_len(0);
            let _ = self.file.sync_all();
            unlink_matching(&self.parent.0, &self.temporary, &self.file);
        }
        if let Some(previous) = &self.previous {
            // Identity verification and no-replace publication preserve files
            // created by another writer while this transaction was in flight.
            let _ = rename_unique(
                &self.parent.0,
                &self.backup,
                previous,
                &self.parent.0,
                &self.name,
            );
        }
    }
}

#[cfg(test)]
#[path = "file_edits_tests.rs"]
mod tests;
