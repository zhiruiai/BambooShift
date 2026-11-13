use crate::{
    db::State,
    error::{ApiError, Body, Result},
    workspace::access,
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

const MAX_ENTRIES: usize = 100;
const MAX_URL_BYTES: usize = 2048;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewRequest {
    candidates: Vec<Candidate>,
    skipped: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Candidate {
    name: String,
    url: String,
}

pub async fn post(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let input: PreviewRequest =
        serde_json::from_value(body).map_err(|_| ApiError::bad("应用导入预览参数无效。"))?;
    if input.skipped > MAX_ENTRIES || input.candidates.len() > MAX_ENTRIES - input.skipped {
        return Err(ApiError::bad("一次最多预览 100 个应用。"));
    }
    let total = input.skipped + input.candidates.len();
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for candidate in input.candidates {
        let name = candidate.name.trim();
        if name.is_empty()
            || candidate.name.encode_utf16().count() > 80
            || candidate.name.chars().any(control_or_format)
        {
            continue;
        }
        let Some(url) = normalize_address(&candidate.url) else {
            continue;
        };
        if seen.insert(url.clone()) {
            candidates.push(Candidate {
                name: name.into(),
                url,
            });
        }
    }
    // Preview never opens a workspace store or enters an application worker.
    actor.authorize(&state).await?;
    Ok(Json(json!({
        "skipped": total - candidates.len(),
        "error": candidates.is_empty().then_some("empty"),
        "candidates": candidates,
    })))
}

fn normalize_address(raw: &str) -> Option<String> {
    if raw.len() > MAX_URL_BYTES
        || raw != raw.trim()
        || raw.contains("${")
        || raw.chars().any(|ch| {
            ch.is_whitespace()
                || control_or_format(ch)
                || matches!(ch, '\\' | '?' | '#' | '<' | '>')
        })
    {
        return None;
    }
    let authority = raw
        .split_once(':')?
        .1
        .trim_start_matches('/')
        .split('/')
        .next()?;
    if authority.contains('@') {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.port().is_some_and(|port| port != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > MAX_URL_BYTES
    {
        return None;
    }
    let url::Host::Domain(host) = url.host()? else {
        return None;
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    let suffix = host.rsplit('.').next()?;
    if !host.contains('.')
        || host
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        || [
            "localhost",
            "local",
            "internal",
            "test",
            "invalid",
            "onion",
            "lan",
            "home",
            "arpa",
        ]
        .contains(&suffix)
        || !host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(url.into())
}

fn control_or_format(ch: char) -> bool {
    // Unicode 17.0.0 DerivedGeneralCategory.txt, General_Category=Format (Cf).
    // https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt
    ch.is_control()
        || matches!(ch,
            '\u{ad}' | '\u{600}'..='\u{605}' | '\u{61c}' | '\u{6dd}' | '\u{70f}'
            | '\u{890}'..='\u{891}' | '\u{8e2}' | '\u{180e}' | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}'
            | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{110bd}' | '\u{110cd}'
            | '\u{13430}'..='\u{1343f}' | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}' | '\u{e0001}' | '\u{e0020}'..='\u{e007f}'
        )
}
