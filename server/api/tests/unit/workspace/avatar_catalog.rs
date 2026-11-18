use super::*;

#[test]
fn classic_is_syncable_without_changing_existing_theme_identifiers() {
    assert!(has_theme("classic"));
    assert!(has_theme("companions"));
    assert!(has_theme("grokbot-blob"));
    assert!(has_theme("colorful"));
    assert_eq!(THEME_MOTIFS.len(), 47);
    assert!(!has_theme("../classic"));
}
