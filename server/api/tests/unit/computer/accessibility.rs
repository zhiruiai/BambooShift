use super::*;

#[test]
fn text_payload_preserves_unicode_and_whitespace_without_target_overrides() {
    let mut input = json!({
        "type":SET_TEXT,"snapshotToken":"ab".repeat(32),"elementId":"5",
        "text":" 交付\t备注\n🚀 ","expectedTargetRevision":uuid::Uuid::new_v4().to_string(),
    });
    let payload = action_payload(SET_TEXT, &input).unwrap();
    assert_eq!(payload["text"], " 交付\t备注\n🚀 ");
    assert!(payload.get("expectedTargetRevision").is_none());
    input["target"] = json!({"app":"unverified"});
    assert!(action_payload(SET_TEXT, &input).is_err());
}

#[test]
fn text_payload_checks_unicode_scalar_limit_and_control_characters() {
    let mut input = json!({"type":SET_TEXT,"snapshotToken":"ab".repeat(32),"elementId":"5"});
    for invalid in [
        json!(""),
        json!("\u{85}"),
        json!("\0"),
        json!("🚀".repeat(2001)),
    ] {
        input["text"] = invalid;
        assert!(action_payload(SET_TEXT, &input).is_err());
    }
    input["text"] = json!("🚀".repeat(2000));
    assert!(action_payload(SET_TEXT, &input).is_ok());
    input["type"] = json!(PRESS);
    assert!(action_payload(PRESS, &input).is_err());
}
