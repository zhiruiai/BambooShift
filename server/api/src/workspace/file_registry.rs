//! Bind file registry records to the object selected by a transaction.
//!
//! Filesystems decide whether spelling aliases identify one file. Never apply
//! global case folding: case-sensitive volumes can hold both spellings.
use super::file_storage::Directory;
use crate::{
    error::{ApiError, Result},
    filesystem::FileStamp,
};
use serde_json::Value;

fn unverified() -> ApiError {
    ApiError::new(409, "文件登记无法核对，请检查资料库后重试；本次未写入。")
        .with_code("FILE_REGISTRY_UNVERIFIED")
}

pub(crate) fn matching_records(
    directory: &Directory,
    requested: &str,
    previous: Option<&FileStamp>,
    registered: &[Value],
) -> Result<Vec<Value>> {
    let mut matching = Vec::new();
    for record in registered {
        let name = record["name"].as_str().ok_or_else(unverified)?;
        let selected = match previous {
            None => name == requested,
            Some(previous) => match directory.reader(name) {
                Ok(reader) => previous.same_identity(&reader.snapshot()?),
                Err(error) if error.code == "FILE_NOT_FOUND" && name != requested => false,
                Err(_) => return Err(unverified()),
            },
        };
        if selected {
            matching.push(record.clone());
        }
    }
    Ok(matching)
}

pub(crate) fn unique_record(mut matching: Vec<Value>) -> Result<Option<Value>> {
    if matching.len() > 1 {
        return Err(ApiError::new(
            409,
            "文件登记存在重复记录，请先整理资料库后重试；本次未写入。",
        )
        .with_code("FILE_REGISTRY_CONFLICT"));
    }
    let record = matching.pop();
    if record
        .as_ref()
        .is_some_and(|record| record["id"].as_str().is_none_or(str::is_empty))
    {
        return Err(unverified());
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn duplicate_registry_entries_have_a_specific_conflict_without_silent_selection() {
        let error = unique_record(vec![
            json!({"id":"one","name":"notes.txt"}),
            json!({"id":"two","name":"Notes.txt"}),
        ])
        .unwrap_err();
        assert_eq!(error.status.as_u16(), 409);
        assert_eq!(error.code, "FILE_REGISTRY_CONFLICT");
    }

    #[test]
    fn missing_objects_keep_exact_name_registration_and_do_not_case_fold() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = Directory::open(temporary.path(), true).unwrap();
        let records = vec![json!({"id":"one","name":"notes.txt"})];
        assert!(
            matching_records(&directory, "Notes.txt", None, &records)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            matching_records(&directory, "notes.txt", None, &records)
                .unwrap()
                .len(),
            1
        );
    }
}
