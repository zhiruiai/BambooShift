use super::*;
use serde_json::json;

#[test]
fn start_matches_worker_units_and_wire_size() {
    let mut value = json!({"systemPrompt":"🌿".repeat(MAX_SYSTEM_UTF16 / 2),"prompt":"task"});
    assert!(start_fits(&value, MAX_START_BYTES));
    assert!(!start_fits(&value, MAX_START_BYTES + 1));
    value["systemPrompt"] = json!("🌿".repeat(MAX_SYSTEM_UTF16 / 2 + 1));
    assert!(!start_fits(&value, MAX_START_BYTES));
    value["systemPrompt"] = json!("small");
    value["prompt"] = json!("x".repeat(MAX_PROMPT_UTF16 + 1));
    assert!(!start_fits(&value, MAX_START_BYTES));
}

#[test]
fn oversized_history_drops_only_oldest_entries() {
    let mut prompt = json!({
        "content":"current human request", "replyContext":{"content":"reply"},
        "originalRequest":{"content":"structured original"}, "webhookEvent":{"source":"fixture"},
        "history":(0..18).map(|index| json!({"content":"🌿".repeat(15000),"index":index})).collect::<Vec<_>>()
    });
    let original = prompt.clone();
    let serialized = serialize_run_prompt(&mut prompt).unwrap();
    let bounded: Value = serde_json::from_str(&serialized).unwrap();
    let omitted = bounded["historyWindow"]["omittedOlderEntries"]
        .as_u64()
        .unwrap() as usize;
    assert!(omitted > 0 && omitted < 18);
    assert_eq!(
        bounded["history"].as_array().unwrap(),
        &original["history"].as_array().unwrap()[omitted..]
    );
    for field in ["content", "replyContext", "originalRequest", "webhookEvent"] {
        assert_eq!(bounded[field], original[field]);
    }
    assert!(serialized.encode_utf16().count() <= MAX_PROMPT_UTF16);
    let mut small = json!({"content":"current", "history":[{"content":"older"}]});
    assert_eq!(serialize_run_prompt(&mut small).unwrap(), small.to_string());
    assert!(small.get("historyWindow").is_none());
}
