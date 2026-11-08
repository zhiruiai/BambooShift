use super::version::Version;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasesConfig {
    pub repository: String,
}
pub fn valid_repository(value: &str) -> bool {
    let Some((owner, repo)) = value.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && owner.len() <= 39
        && owner.as_bytes()[0].is_ascii_alphanumeric()
        && owner.as_bytes()[owner.len() - 1].is_ascii_alphanumeric()
        && owner
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        && !owner.contains("--")
        && !repo.is_empty()
        && repo.len() <= 100
        && ![".", ".."].contains(&repo)
        && repo
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub tag: String,
    pub version: Option<String>,
    pub name: String,
    pub notes: String,
    pub published_at: String,
    pub url: String,
}
fn parse(value: Value, repository: &str) -> Result<Release, &'static str> {
    if value["draft"] != false || value["prerelease"] != false {
        return Err("invalid_release");
    }
    let tag = value["tag_name"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && ![".", ".."].contains(s)
                && s.len() <= 128
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(&c))
        })
        .ok_or("invalid_release")?;
    let canonical = tag.strip_prefix('v').unwrap_or(tag);
    let version = Version::parse(canonical)
        .filter(Version::stable)
        .map(|_| canonical.to_owned());
    if Version::parse(canonical).is_some_and(|v| !v.stable()) {
        return Err("invalid_release");
    }
    let url = format!("https://github.com/{repository}/releases/tag/{tag}");
    if !value["html_url"].as_str().is_some_and(|href| {
        href.split_once("/releases/tag/")
            .is_some_and(|(prefix, suffix)| {
                prefix.eq_ignore_ascii_case(&format!("https://github.com/{repository}"))
                    && suffix == tag
            })
    }) {
        return Err("invalid_release");
    }
    let published = value["published_at"]
        .as_str()
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .ok_or("invalid_release")?;
    let name = value["name"].as_str().unwrap_or(tag);
    let notes = value["body"].as_str().unwrap_or("");
    if name.chars().count() > 200 || notes.chars().count() > 32000 {
        return Err("response_too_large");
    }
    Ok(Release {
        tag: tag.to_owned(),
        version,
        name: name.to_owned(),
        notes: notes.to_owned(),
        published_at: published.to_owned(),
        url,
    })
}
pub(super) struct ReleaseClient {
    client: reqwest::Client,
    endpoint: String,
}
impl ReleaseClient {
    pub(super) fn new(repository: &str) -> Result<Self, &'static str> {
        Self::build(
            format!("https://api.github.com/repos/{repository}/releases/latest"),
            Duration::from_secs(8),
        )
    }
    fn build(endpoint: String, timeout: Duration) -> Result<Self, &'static str> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(timeout)
            .user_agent("OpenBot-update-check")
            .build()
            .map_err(|_| "network")?;
        Ok(Self { client, endpoint })
    }
    #[cfg(test)]
    pub(super) fn fixture(endpoint: String, timeout: Duration) -> Self {
        Self::build(endpoint, timeout).unwrap()
    }
    pub(super) async fn fetch(&self, repository: &str) -> Result<Release, &'static str> {
        let mut response = self
            .client
            .get(&self.endpoint)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2026-03-10")
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                404 => "not_found",
                403 | 429 => "rate_limited",
                _ => "network",
            });
        }
        const LIMIT: usize = 256 * 1024;
        if response
            .content_length()
            .is_some_and(|length| length > LIMIT as u64)
        {
            return Err("response_too_large");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len() + chunk.len() > LIMIT {
                return Err("response_too_large");
            }
            bytes.extend_from_slice(&chunk);
        }
        parse(
            serde_json::from_slice(&bytes).map_err(|_| "invalid_release")?,
            repository,
        )
    }
}
fn network_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else {
        "network"
    }
}
