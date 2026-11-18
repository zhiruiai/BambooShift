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
