use super::*;
#[test]
fn oversized_export_fails_without_claiming_a_partial_result() {
    let mut transcript =
        Transcript::new(&serde_json::json!({"title":"Test"}), "now", false).unwrap();
    assert!(transcript.append(&"x".repeat(LIMIT)).is_err());
}
#[test]
fn includes_visible_voice_text_and_question_choices_without_raw_metadata() {
    let mut transcript =
        Transcript::new(&serde_json::json!({"title":"Test"}), "now", false).unwrap();
    transcript.push(&serde_json::json!({"kind":"file","content":"memo.wav","metadata":{"voiceMemo":{"transcript":"Spoken content","durationMs":2000},"secret":"never-export"}}), &[], None).unwrap();
    transcript.push(&serde_json::json!({"kind":"question","content":"Choose","metadata":{"question":{"options":[{"id":"a","label":"Option A","description":"Visible detail"},{"id":"b","label":"Option B"}],"answer":{"optionIds":["b"]},"runId":"never-export"}}}), &[], None).unwrap();
    assert!(
        transcript
            .content
            .contains("Voice transcript:\n\nSpoken content")
    );
    assert!(
        transcript
            .content
            .contains("- [ ] Option A — Visible detail")
    );
    assert!(transcript.content.contains("- [x] Option B"));
    assert!(!transcript.content.contains("never-export"));
}
