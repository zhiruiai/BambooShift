use markdown::{ParseOptions, mdast::Node, to_mdast};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use url::Url;

pub(super) fn normalize(value: &str) -> Option<String> {
    let (scheme, _) = value.split_once("://")?;
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        || value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\\' | '\u{feff}'))
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    (url.has_host() && url.username().is_empty() && url.password().unwrap_or_default().is_empty())
        .then(|| url.into())
}

pub(super) fn message_targets(message: &Value) -> HashSet<String> {
    if !matches!(message["role"].as_str(), Some("user" | "assistant"))
        || !matches!(message["kind"].as_str(), None | Some("text"))
        || message["status"] == "running"
    {
        return HashSet::new();
    }
    let content = message["content"].as_str().unwrap_or_default();
    let Ok(tree) = to_mdast(content, &ParseOptions::gfm()) else {
        return HashSet::new();
    };
    let mut definitions = HashMap::new();
    let mut links = Vec::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        match node {
            Node::Definition(definition) => {
                definitions
                    .entry(definition.identifier.as_str())
                    .or_insert(definition.url.as_str());
            }
            Node::Link(_) | Node::LinkReference(_) => links.push(node),
            _ => {}
        }
        if let Some(children) = node.children() {
            pending.extend(children.iter().rev());
        }
    }
    let mut targets = HashSet::new();
    for link in links {
        let url = match link {
            Node::Link(link) => Some(link.url.as_str()),
            Node::LinkReference(reference) => {
                definitions.get(reference.identifier.as_str()).copied()
            }
            _ => None,
        };
        if let Some(target) = url.and_then(normalize) {
            targets.insert(target);
            if targets.len() == 64 {
                break;
            }
        }
    }
    targets
}

#[cfg(test)]
mod tests {
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
}
