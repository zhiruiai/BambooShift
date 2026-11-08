use std::cmp::Ordering;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}
fn identifiers(value: &str, prerelease: bool) -> Option<Vec<String>> {
    let values: Vec<_> = value.split('.').collect();
    if values.iter().any(|item| {
        item.is_empty()
            || !item.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || (prerelease
                && item.bytes().all(|c| c.is_ascii_digit())
                && item.len() > 1
                && item.starts_with('0'))
    }) {
        return None;
    }
    Some(values.into_iter().map(str::to_owned).collect())
}
impl Version {
    pub(super) fn parse(value: &str) -> Option<Self> {
        if value.len() > 128 || !value.is_ascii() {
            return None;
        }
        let mut build = value.split('+');
        let base = build.next()?;
        if let Some(value) = build.next() {
            identifiers(value, false)?;
        }
        if build.next().is_some() {
            return None;
        }
        let (core, pre) = base
            .split_once('-')
            .map_or((base, None), |(a, b)| (a, Some(b)));
        let parts: Vec<_> = core.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        let mut result = [0; 3];
        for (index, part) in parts.iter().enumerate() {
            if part.is_empty()
                || !part.bytes().all(|c| c.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
            {
                return None;
            }
            result[index] = part.parse().ok()?;
        }
        Some(Self {
            core: result,
            pre: match pre {
                Some(value) => identifiers(value, true)?,
                None => vec![],
            },
        })
    }
    pub(super) fn stable(&self) -> bool {
        self.pre.is_empty()
    }
    pub(super) fn compare(&self, other: &Self) -> Ordering {
        match self.core.cmp(&other.core) {
            Ordering::Equal => {}
            value => return value,
        }
        match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            _ => {}
        }
        for (a, b) in self.pre.iter().zip(&other.pre) {
            let numeric_a = a.bytes().all(|c| c.is_ascii_digit());
            let numeric_b = b.bytes().all(|c| c.is_ascii_digit());
            let order = match (numeric_a, numeric_b) {
                (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => a.cmp(b),
            };
            if order != Ordering::Equal {
                return order;
            }
        }
        self.pre.len().cmp(&other.pre.len())
    }
}
pub(super) fn status(current: &str, latest: Option<&str>) -> &'static str {
    let Some(current) = Version::parse(current) else {
        return "unknownVersion";
    };
    let Some(latest) = latest.and_then(Version::parse) else {
        return "unknownVersion";
    };
    if !latest.stable() {
        return "unknownVersion";
    }
    if current.compare(&latest) == Ordering::Less {
        "update_available"
    } else {
        "current"
    }
}
