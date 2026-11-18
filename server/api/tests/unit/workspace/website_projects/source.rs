use super::*;

#[test]
fn pages_preserve_utf8_without_gaps_or_overlaps() {
    let first = "A".repeat(TEXT_PAGE_BYTES - 1);
    let text = format!("{first}星夜🚀");
    let (page, next) = text_page(&text, 0).unwrap();
    assert_eq!(page, first);
    assert_eq!(text_page(&text, next.unwrap()).unwrap(), ("星夜🚀", None));
    assert!(text_page(&text, TEXT_PAGE_BYTES).is_err());
    assert!(text_page(&text, text.len() + 1).is_err());
}
