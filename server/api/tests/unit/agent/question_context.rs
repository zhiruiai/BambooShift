use super::history_entry;
use serde_json::json;

#[test]
fn file_history_exposes_exact_reference_without_forwarding_arbitrary_metadata() {
    let entry = history_entry(&json!({
        "kind":"file","role":"user","userId":"owner","content":"fixture.csv",
        "metadata":{"fileId":"e6809b2c-6079-4ede-bc4f-01c1cb56e916",
            "path":"PRIVATE_HOST_PATH","token":"PRIVATE_TOKEN","mime":"UNTRUSTED_MIME"}
    }));
    assert_eq!(
        entry["attachment"],
        json!({
            "fileId":"e6809b2c-6079-4ede-bc4f-01c1cb56e916","name":"fixture.csv"
        })
    );
    assert!(!entry.to_string().contains("PRIVATE_"));
    assert!(!entry.to_string().contains("UNTRUSTED_MIME"));
    assert!(entry.get("metadata").is_none());
}

#[test]
fn text_and_invalid_file_references_do_not_become_attachment_handles() {
    for message in [
        json!({"kind":"text","content":"fixture.csv","metadata":{"fileId":"valid-id"}}),
        json!({"kind":"file","content":"fixture.csv","metadata":{"fileId":"fixture.csv"}}),
        json!({"kind":"file","content":"fixture.csv"}),
    ] {
        assert!(history_entry(&message).get("attachment").is_none());
    }
}
