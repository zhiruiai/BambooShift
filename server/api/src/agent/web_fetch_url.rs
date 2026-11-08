use crate::error::{ApiError, Result};
use std::{net::IpAddr, time::Duration};
use url::{Host, Url};

pub(crate) fn validate_url(raw: &str) -> Result<String> {
    if raw.is_empty()
        || raw.len() > super::MAX_URL
        || raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err(super::invalid());
    }
    let url = Url::parse(raw).map_err(|_| super::invalid())?;
    let Host::Domain(host) = url.host().ok_or_else(super::invalid)? else {
        return Err(super::invalid());
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
        || !public_domain(host)
    {
        return Err(super::invalid());
    }
    // Url removes an explicit default port and normalizes scheme, host and path.
    let normalized = url.to_string();
    if normalized.len() > super::MAX_URL {
        return Err(super::invalid());
    }
    Ok(normalized)
}
fn public_domain(host: &str) -> bool {
    let labels: Vec<_> = host.split('.').collect();
    let special = [
        "localhost",
        "local",
        "localdomain",
        "internal",
        "intranet",
        "lan",
        "home",
        "corp",
        "test",
        "invalid",
        "example",
        "onion",
        "arpa",
        "alt",
    ];
    host.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
        && !special.contains(labels.last().unwrap())
        && !labels
            .iter()
            .any(|label| matches!(*label, "localhost" | "localdomain"))
        && labels.last().is_some_and(|label| {
            label.starts_with("xn--") || label.bytes().all(|c| c.is_ascii_alphabetic())
        })
}
pub(super) async fn check_dns(normalized: &str) -> Result<()> {
    let url = Url::parse(normalized).map_err(|_| super::invalid())?;
    let host = url.host_str().ok_or_else(super::invalid)?;
    let port = url.port_or_known_default().ok_or_else(super::invalid)?;
    let addresses = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| dns_error())?
    .map_err(|_| dns_error())?
    .map(|value| value.ip())
    .collect::<Vec<_>>();
    validate_addresses(&addresses)
}
fn dns_error() -> ApiError {
    ApiError::new(502, "暂时无法确认该网址的公网地址，请稍后重试。")
        .with_code("WEB_FETCH_DNS_UNAVAILABLE")
}
pub(super) fn validate_addresses(addresses: &[IpAddr]) -> Result<()> {
    if addresses.is_empty() {
        return Err(dns_error());
    }
    if addresses.iter().any(|address| !public_address(*address)) {
        return Err(super::invalid());
    }
    Ok(())
}
fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(address) => {
            if let Some(ipv4) = address.to_ipv4_mapped() {
                return public_address(IpAddr::V4(ipv4));
            }
            let parts = address.segments();
            // Admit global unicast only, excluding transition and documentation blocks.
            parts[0] & 0xe000 == 0x2000
                && parts[0] != 0x2002
                && !(parts[0] == 0x2001 && (parts[1] < 0x0200 || parts[1] == 0x0db8))
                && !(parts[0] == 0x3fff && parts[1] < 0x1000)
        }
    }
}
