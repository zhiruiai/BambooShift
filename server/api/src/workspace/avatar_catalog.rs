use serde::Deserialize;
use std::sync::LazyLock;

const ORIGINAL_THEMES: [&str; 5] = ["companions", "pandas", "dinosaurs", "chicks", "elephants"];

#[derive(Deserialize)]
struct Catalog {
    packs: Vec<Pack>,
}

#[derive(Deserialize)]
struct Pack {
    themes: Vec<Theme>,
}

#[derive(Deserialize)]
struct Theme {
    id: String,
}

// Compile the same small catalog used by both clients; no paths or user assets are accepted.
pub(crate) static THEME_MOTIFS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let catalog: Catalog =
        serde_json::from_str(include_str!("../../../../shared/avatar-packs/catalog.json"))
            .expect("bundled avatar catalog must be valid");
    ORIGINAL_THEMES
        .into_iter()
        .map(str::to_owned)
        .chain(std::iter::once(
            serde_json::from_str::<Theme>(include_str!("../../../../shared/avatar-classic.json"))
                .expect("bundled classic avatar must be valid")
                .id,
        ))
        .chain(
            catalog
                .packs
                .into_iter()
                .flat_map(|pack| pack.themes.into_iter().map(|theme| theme.id)),
        )
        .collect()
});

pub(crate) fn has_theme(id: &str) -> bool {
    THEME_MOTIFS.iter().any(|theme| theme == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classic_is_syncable_without_changing_existing_theme_identifiers() {
        assert!(has_theme("classic"));
        assert!(has_theme("companions"));
        assert!(has_theme("grokbot-blob"));
        assert_eq!(THEME_MOTIFS.len(), 46);
        assert!(!has_theme("../classic"));
    }
}
