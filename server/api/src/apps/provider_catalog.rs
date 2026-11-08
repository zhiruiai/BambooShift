use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Provider {
    pub id: String,
    pub name: String,
    pub category: String,
    pub auth_type: String,
    pub url: String,
    pub documentation: String,
    #[serde(default)]
    pub keywords: String,
}

pub(crate) fn entries() -> &'static [Provider] {
    static CATALOG: OnceLock<Vec<Provider>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../shared/app-providers.json"))
            .expect("The checked-in app catalog is valid")
    })
}

fn address(value: &str) -> &str {
    value.strip_suffix('/').unwrap_or(value)
}

pub(crate) fn for_endpoint(value: &str) -> Option<&'static Provider> {
    entries()
        .iter()
        .find(|provider| provider.matches_endpoint(value))
}

impl Provider {
    pub(crate) fn matches_endpoint(&self, url: &str) -> bool {
        address(&self.url) == address(url)
    }

    pub(crate) fn matches(&self, query: &str) -> bool {
        let terms = format!(
            "{} {} {} {} {}",
            self.id, self.name, self.category, self.documentation, self.keywords
        )
        .to_lowercase();
        query.split_whitespace().all(|word| terms.contains(word))
    }
}
