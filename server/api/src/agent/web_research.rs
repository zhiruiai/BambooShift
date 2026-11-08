use super::{threads, tools::ToolContext, web_search, web_tools};
use crate::{
    apps::Authority,
    db::{iso, now},
    error::Result,
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn issue(code: &str) -> Option<&'static str> {
    Some(match code {
        "WEB_SEARCH_TASK_LIMIT" => "search_task_limit",
        "WEB_SEARCH_RETRY_LIMIT" => "search_retry_limit",
        "WEB_FETCH_TASK_LIMIT" => "fetch_task_limit",
        "WEB_SEARCH_RATE_LIMITED" | "WEB_FETCH_RATE_LIMITED" => "upstream_rate_limit",
        "WEB_SEARCH_TIMEOUT" | "WEB_FETCH_TIMEOUT" => "timeout",
        "WEB_SEARCH_UNAVAILABLE" | "WEB_FETCH_UNAVAILABLE" | "WEB_FETCH_DNS_UNAVAILABLE" => {
            "unavailable"
        }
        "WEB_FETCH_EMPTY" => "fetch_empty",
        "WEB_SEARCH_BAD_RESPONSE" | "WEB_FETCH_BAD_RESPONSE" | "WEB_FETCH_FAILED" => "failed",
        _ => return None,
    })
}

fn empty() -> Value {
    json!({"version":1,"provider":"Exa","searches":0,"cachedSearches":0,
        "emptySearches":0,"pagesRead":0,"issues":[],"sources":[]})
}

fn increment(summary: &mut Value, key: &str) {
    summary[key] = json!(
        summary[key]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(1)
            .min(9999)
    );
}

fn source(summary: &mut Value, value: &Value, kind: &str) {
    let Some(url) = value["url"].as_str().and_then(web_search::public_url) else {
        return;
    };
    let sources = summary["sources"].as_array_mut().unwrap();
    if let Some(existing) = sources.iter_mut().find(|source| source["url"] == url) {
        if kind == "page" {
            existing["kind"] = json!("page");
        }
        return;
    }
    if sources.len() >= 12 {
        return;
    }
    let mut units = 0;
    let title = value["title"].as_str().unwrap_or("").chars()
        .filter(|ch| !ch.is_control() && !matches!(*ch,
            '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .take_while(|ch| { units += ch.len_utf16(); units <= 240 }).collect::<String>();
    let title = title.trim();
    let title = if title.is_empty() {
        url.chars().take(240).collect()
    } else {
        title.to_owned()
    };
    sources.push(json!({"title":title,"url":url,"kind":kind}));
}

fn merge(summary: &mut Value, name: &str, result: &Result<Value>) {
    match result {
        Ok(output) if name == web_tools::SEARCH => {
            if output["reusedQuery"] == true {
                increment(summary, "cachedSearches");
            } else {
                increment(summary, "searches");
                if output["results"].as_array().is_some_and(Vec::is_empty) {
                    increment(summary, "emptySearches");
                }
            }
            for value in output["results"].as_array().into_iter().flatten() {
                source(summary, value, "search");
            }
        }
        Ok(output) if name == web_tools::FETCH => {
            increment(summary, "pagesRead");
            source(summary, &output["page"], "page");
        }
        Err(error) => {
            if let Some(issue) = issue(error.code) {
                let issues = summary["issues"].as_array_mut().unwrap();
                if !issues.iter().any(|value| value == issue) {
                    issues.push(json!(issue));
                }
            }
        }
        _ => {}
    }
}

pub(super) async fn record(
    store: &WorkspaceStore,
    context: &ToolContext<'_>,
    name: &str,
    result: &Result<Value>,
    authorize: &Authority,
) -> Result<()> {
    // Validation, permission, and stale-run failures are not research outcomes.
    if result
        .as_ref()
        .err()
        .is_some_and(|error| issue(error.code).is_none())
    {
        return Ok(());
    }
    authorize().await?;
    let active = context.active;
    let hash = Sha256::digest(format!(
        "web-research:{}:{}",
        active.run_id, context.generation
    ));
    let id = uuid::Uuid::from_bytes(hash[..16].try_into().unwrap()).to_string();
    let mut tx = store.begin().await?;
    // The workspace write lock prevents a concurrent deletion or membership edit
    // between this check and publication. Account/grant checks run again below.
    let chat =
        WorkspaceStore::get_in(&mut tx, Table::Conversations, &active.conversation_id).await?;
    if !chat.as_ref().is_some_and(|chat| {
        chat["agentIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == &active.agent_id))
    }) || WorkspaceStore::get_in(&mut tx, Table::Agents, &active.agent_id)
        .await?
        .is_none()
    {
        return Err(crate::error::ApiError::new(
            409,
            "负责的 Bot 已离开当前会话，检索回执未保存。",
        ));
    }
    if let Some(thread) = active.thread_root_id.as_deref() {
        threads::root(&mut tx, &active.conversation_id, thread).await?;
    }
    let mut message = WorkspaceStore::get_in(&mut tx, Table::Messages, &id)
        .await?
        .unwrap_or_else(|| {
            json!({"id":id,"conversationId":active.conversation_id,"agentId":active.agent_id,
            "role":"assistant","kind":"web_research","status":"done","content":"",
            "createdAt":iso(now()),"metadata":{"runId":active.run_id,
                "inputMessageId":context.input["id"],"inputGeneration":context.generation,
                "webResearch":empty()}})
        });
    threads::stamp(&mut message, active.thread_root_id.as_deref());
    merge(&mut message["metadata"]["webResearch"], name, result);
    WorkspaceStore::put_in(&mut tx, Table::Messages, &message).await?;
    authorize().await?;
    super::tools::check_fence(active, context.generation)?;
    tx.commit().await?;
    store.emit("message", message);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_is_bounded_deduplicated_and_contains_no_provider_body() {
        let mut summary = empty();
        summary["searches"] = json!(9999);
        let rows = (0..20)
            .map(|n| {
                json!({"url":format!("https://example.com/{n}"),
            "title":format!("\u{202e}{}\u{0001}", "a".repeat(300)),"snippet":"PRIVATE_QUERY_BODY"})
            })
            .collect::<Vec<_>>();
        let output = Ok(json!({"results":rows,"reusedQuery":false}));
        merge(&mut summary, web_tools::SEARCH, &output);
        merge(&mut summary, web_tools::SEARCH, &output);
        assert_eq!(summary["searches"], 9999);
        assert_eq!(summary["sources"].as_array().unwrap().len(), 12);
        assert_eq!(summary["sources"][0]["title"].as_str().unwrap().len(), 240);
        assert!(!summary.to_string().contains("PRIVATE_QUERY_BODY"));
        source(
            &mut summary,
            &json!({"url":"https://example.com/0"}),
            "page",
        );
        assert_eq!(summary["sources"][0]["kind"], "page");
        assert_eq!(summary["sources"].as_array().unwrap().len(), 12);
        let error = Err(
            crate::error::ApiError::new(429, "RAW_SECRET").with_code("WEB_SEARCH_RATE_LIMITED")
        );
        merge(&mut summary, web_tools::SEARCH, &error);
        merge(&mut summary, web_tools::SEARCH, &error);
        assert_eq!(summary["issues"], json!(["upstream_rate_limit"]));
        assert!(!summary.to_string().contains("RAW_SECRET"));
        assert!(issue("WEB_FETCH_INVALID").is_none());
        assert!(issue("FORBIDDEN").is_none());
        let dns = Err(crate::error::ApiError::new(502, "DNS_PROVIDER_DETAIL")
            .with_code("WEB_FETCH_DNS_UNAVAILABLE"));
        merge(&mut summary, web_tools::FETCH, &dns);
        assert_eq!(
            summary["issues"],
            json!(["upstream_rate_limit", "unavailable"])
        );
        assert_eq!(summary["pagesRead"], 0);
        assert!(!summary.to_string().contains("DNS_PROVIDER_DETAIL"));
    }

    #[test]
    fn titles_use_client_utf16_limits_and_urls_keep_the_public_result_policy() {
        let mut summary = empty();
        source(
            &mut summary,
            &json!({"url":"https://example.com/emoji","title":"😀".repeat(240)}),
            "search",
        );
        assert_eq!(
            summary["sources"][0]["title"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            240
        );
        source(
            &mut summary,
            &json!({"url":"http://127.0.0.1/private","title":"Hidden"}),
            "search",
        );
        assert_eq!(summary["sources"].as_array().unwrap().len(), 1);
        source(
            &mut summary,
            &json!({"url":"https://example.com/fallback","title":"\u{202e}\u{0001}"}),
            "search",
        );
        assert_eq!(
            summary["sources"][1]["title"],
            "https://example.com/fallback"
        );
    }
}
