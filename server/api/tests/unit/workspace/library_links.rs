use super::*;
use serde_json::json;

#[test]
fn indexes_gfm_anchors_and_references_without_markup_code_or_credentials() {
    let links = message_targets(&json!({"kind":"text","role":"user","content":r#"
[Inline](HTTPS://EXAMPLE.COM:443/guide) and www.example.net.
[Reference][release] and <https://example.org>

[release]: https://example.com/releases

`https://example.com/code` ![image](https://example.com/image)
<a href="https://example.com/raw">Raw</a> [credentials](https://user:secret@example.com)
"#}));
    assert_eq!(
        links,
        HashSet::from([
            "https://example.com/guide".into(),
            "http://www.example.net/".into(),
            "https://example.com/releases".into(),
            "https://example.org/".into(),
        ])
    );
}
