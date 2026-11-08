mod agent_delegation_support;
mod web_research_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, role, wait_gate};
use openbot_backend::{agent::AgentRegistry, workspace::Table};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use web_research_support::{Provider, SOURCE, cards, last_tool};

#[tokio::test]
async fn actual_pi_persists_compact_evidence_without_turn_history_or_unread_side_effects() {
    let mut group = Group::new().await;
    let provider = Provider::new().await;
    group.f.state.agent_runs = Arc::new(AgentRegistry::with_web_fixture(&provider.origin).unwrap());
    let steps = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |body| {
        let step = steps.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match step {
                0 | 1 => call(
                    "web_search",
                    json!({"query":"PRIVATE_QUERY_NOT_FOR_RECEIPT"}),
                ),
                2 => call("web_search", json!({"query":"empty result"})),
                3 => call("web_fetch", json!({"url":SOURCE})),
                4 => call("web_fetch", json!({"url":"https://example.com/empty"})),
                5 => {
                    assert!(last_tool(&body).contains("没有返回可读取的正文"));
                    call("web_fetch", json!({"url":"http://127.0.0.1/private"}))
                }
                6 => call("web_search", json!({"query":"rate limited"})),
                7 => finish("Research finished with an explicit empty page and rate limit."),
                8 => {
                    assert!(!body.to_string().contains("web_research"));
                    assert!(!body.to_string().contains("cachedSearches"));
                    finish("Follow-up retained ordinary history only.")
                }
                _ => panic!("Unexpected synthetic model request {step}"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Research the public fixture.", "followUp", false)
        .await;
    let messages = group.done().await;
    let receipts = cards(&messages);
    assert_eq!(receipts.len(), 1, "{messages:?}");
    let card = receipts[0];
    assert_eq!(card["content"], "");
    assert_eq!(card["status"], "done");
    assert_eq!(card["agentId"], group.ids[0]);
    assert_eq!(
        card["metadata"]["webResearch"],
        json!({"version":1,"provider":"Exa",
        "searches":2,"cachedSearches":1,"emptySearches":1,"pagesRead":1,
        "issues":["fetch_empty","upstream_rate_limit"],
        "sources":[{"title":"Verified public source","url":SOURCE,"kind":"page"}]})
    );
    assert!(!card.to_string().contains("PRIVATE_"));
    assert_eq!(provider.requests.load(Ordering::SeqCst), 5);
    let unread: i64 =
        sqlx::query_scalar("SELECT count(*) FROM unread_deliveries WHERE message_id=?")
            .bind(card["id"].as_str().unwrap())
            .fetch_one(&group.store.pool)
            .await
            .unwrap();
    assert_eq!(unread, 0);
    group
        .send("Continue without a new lookup.", "followUp", false)
        .await;
    assert_eq!(cards(&group.done().await).len(), 1);
    group.close().await;
}

#[tokio::test]
async fn explicit_group_recipients_and_delegates_get_their_own_thread_receipts() {
    let mut group = Group::new().await;
    let provider = Provider::new().await;
    group.f.state.agent_runs = Arc::new(AgentRegistry::with_web_fixture(&provider.origin).unwrap());
    let child = group.ids[2].clone();
    let steps = Arc::new([
        AtomicUsize::new(0),
        AtomicUsize::new(0),
        AtomicUsize::new(0),
    ]);
    let model = Model::new(Arc::new(move |body| {
        let bot = role(&body);
        let step = steps[bot].fetch_add(1, Ordering::SeqCst);
        let child = child.clone();
        Box::pin(async move {
            match (bot, step) {
                (0 | 1 | 2, 0) => call(
                    "web_search",
                    json!({"query":format!("Public source for colleague {bot}")}),
                ),
                (0, 1) => call(
                    "delegate",
                    json!({"agentId":child,"task":"Review one public source."}),
                ),
                _ => finish("Verified independent colleague research."),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .store
        .put(
            Table::Messages,
            &json!({"id":"research-thread-root","conversationId":group.cid,
        "role":"user","content":"Original topic","createdAt":"2026-11-08T00:00:00Z"}),
        )
        .await
        .unwrap();
    let (status, result) = group.f.request("POST", &group.f.path(&format!("/conversations/{}/messages",group.cid)),
        Some(json!({"content":"Research together.","clientId":"research-recipients","threadRootId":"research-thread-root",
            "mentions":{"agentIds":[group.ids[0],group.ids[1]]}})), false, Some(&group.f.owner)).await;
    assert_eq!(status, 202, "{result}");
    let messages = group.done().await;
    let receipts = cards(&messages);
    assert_eq!(receipts.len(), 3, "{messages:?}");
    let mut ids = std::collections::HashSet::new();
    let mut runs = std::collections::HashSet::new();
    for card in receipts {
        assert_eq!(card["threadRootId"], "research-thread-root");
        assert_eq!(card["metadata"]["webResearch"]["searches"], 1);
        assert_eq!(card["metadata"]["webResearch"]["issues"], json!([]));
        assert!(ids.insert(card["id"].as_str().unwrap()));
        assert!(runs.insert(card["metadata"]["runId"].as_str().unwrap()));
    }
    assert_eq!(provider.requests.load(Ordering::SeqCst), 3);
    group.close().await;
}

#[tokio::test]
async fn in_flight_results_cannot_publish_after_stop_or_membership_revocation() {
    for revoke in [false, true] {
        let mut group = Group::new().await;
        let provider = Provider::new().await;
        group.f.state.agent_runs =
            Arc::new(AgentRegistry::with_web_fixture(&provider.origin).unwrap());
        provider.hold.store(true, Ordering::SeqCst);
        let model = Model::new(Arc::new(move |_| {
            Box::pin(async { call("web_search", json!({"query":"Delayed public evidence"})) })
        }))
        .await;
        group.configure(&model).await;
        group
            .send("Wait for actual evidence.", "followUp", revoke)
            .await;
        wait_gate(&provider.arrived).await;
        if revoke {
            sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
                .bind(&group.f.workspace)
                .bind(&group.f.member)
                .execute(&group.f.db)
                .await
                .unwrap();
        } else {
            group.stop().await;
        }
        provider.release.add_permits(1);
        assert!(cards(&group.done().await).is_empty());
        assert_eq!(provider.requests.load(Ordering::SeqCst), 1);
        group.close().await;
    }
}

#[tokio::test]
#[ignore = "Uses the live public Exa service with a public synthetic query"]
async fn actual_pi_live_exa_persists_public_sources_and_cache_reuse() {
    let group = Group::new().await;
    let steps = Arc::new(AtomicUsize::new(0));
    let driver = steps.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = driver.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match step {
                0 | 1 => call(
                    "web_search",
                    json!({"query":"site:pi.dev how Pi works coding agent","limit":2}),
                ),
                2 => {
                    assert!(last_tool(&body).contains("\"reusedQuery\":true"));
                    finish("Verified public Pi sources and reused the actual result.")
                }
                _ => panic!("Unexpected live regression model request"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Check official public Pi documentation.", "followUp", false)
        .await;
    let messages = group.done().await;
    let receipts = cards(&messages);
    assert_eq!(receipts.len(), 1, "{messages:?}");
    let summary = &receipts[0]["metadata"]["webResearch"];
    assert_eq!(summary["searches"], 1);
    assert_eq!(summary["cachedSearches"], 1);
    assert_eq!(summary["issues"], json!([]));
    assert!(!summary["sources"].as_array().unwrap().is_empty());
    assert_eq!(steps.load(Ordering::SeqCst), 3);
    group.close().await;
}

#[tokio::test]
async fn steering_preserves_prior_evidence_and_fences_the_old_in_flight_generation() {
    let mut group = Group::new().await;
    let provider = Provider::new().await;
    group.f.state.agent_runs = Arc::new(AgentRegistry::with_web_fixture(&provider.origin).unwrap());
    let steps = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |body| {
        let step = steps.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match step {
                0 => call("web_search", json!({"query":"Initial accepted source"})),
                1 => call("web_search", json!({"query":"delayed result"})),
                _ if !body.to_string().contains("NEW_CURRENT_REQUIREMENT") => {
                    finish("Awaiting the new requirement.")
                }
                _ if !last_tool(&body).starts_with("Public web search results.") => call(
                    "web_search",
                    json!({"query":"Fresh source for revised requirement"}),
                ),
                _ => finish("The revised requirement has current evidence."),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let original = group.send("Initial research.", "followUp", false).await;
    wait_gate(&provider.arrived).await;
    group
        .send(
            "NEW_CURRENT_REQUIREMENT: revise the research.",
            "steer",
            false,
        )
        .await;
    provider.release.add_permits(1);
    let messages = group.done().await;
    let receipts = cards(&messages);
    assert_eq!(receipts.len(), 2, "{messages:?}");
    assert_ne!(receipts[0]["id"], receipts[1]["id"]);
    assert_ne!(
        receipts[0]["metadata"]["inputGeneration"],
        receipts[1]["metadata"]["inputGeneration"]
    );
    for card in receipts {
        assert_eq!(card["metadata"]["runId"], original["delivery"]["runId"]);
        assert_eq!(card["metadata"]["webResearch"]["searches"], 1);
        assert_eq!(card["metadata"]["webResearch"]["issues"], json!([]));
    }
    assert_eq!(provider.requests.load(Ordering::SeqCst), 3);
    group.close().await;
}
