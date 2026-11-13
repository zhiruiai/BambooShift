//! Resolve native programs before a worker changes its working directory.
//!
//! Callers supply the environment explicitly. Windows accepts native `.exe`
//! files only; shell scripts and empty/relative PATH entries are not searched.

use std::path::{Path, PathBuf};

fn native_name(path: &Path, suffix: &str) -> Option<PathBuf> {
    if path.file_name().is_none()
        || path
            .as_os_str()
            .as_encoded_bytes()
            .last()
            .is_some_and(|byte| std::path::is_separator(*byte as char))
    {
        return None;
    }
    match suffix {
        "" => Some(path.to_owned()),
        ".exe" => match path.extension() {
            None => Some(path.with_extension("exe")),
            Some(extension) if extension.eq_ignore_ascii_case("exe") => Some(path.to_owned()),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn resolve(
    selected: &Path,
    search_paths: impl IntoIterator<Item = PathBuf>,
    base: &Path,
    suffix: &str,
) -> Option<PathBuf> {
    let named = native_name(selected, suffix)?;
    let explicit = selected.has_root()
        || selected
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty());
    if explicit {
        let candidate = if named.is_absolute() {
            named
        } else {
            base.join(named)
        };
        // In particular, reject Windows drive-relative paths that remain
        // relative after joining. Never redirect a missing explicit path.
        return (candidate.is_absolute() && candidate.is_file()).then_some(candidate);
    }
    search_paths
        .into_iter()
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(&named))
        // Node installations on Unix commonly use a symlink to the versioned
        // binary. Preserve that supported behavior instead of canonicalizing.
        .find(|candidate| candidate.is_file())
}

pub(crate) fn sibling(current: &Path, stem: &str, suffix: &str) -> Option<PathBuf> {
    if !current.is_absolute() || Path::new(stem).components().count() != 1 {
        return None;
    }
    let mut directory = current.parent()?;
    if directory.file_name().is_some_and(|name| name == "deps") {
        directory = directory.parent()?;
    }
    let candidate = directory.join(native_name(Path::new(stem), suffix)?);
    std::fs::symlink_metadata(&candidate)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .then_some(candidate)
}

#[cfg(test)]
#[path = "executable_tests.rs"]
mod tests;
