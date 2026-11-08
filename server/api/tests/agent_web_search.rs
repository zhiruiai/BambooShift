mod agent_delegation_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const QUERIES: [&str; 13] = [
    "site:pi.dev Pi coding agent how it works",
    "site:blog.rust-lang.org Rust language stable release",
    "site:sqlite.org SQLite write ahead logging documentation",
    "site:docs.flutter.dev Flutter accessibility overview",
    "site:developer.mozilla.org Content Security Policy reference",
    "site:docs.github.com GitHub Actions workflow syntax documentation",
    "site:docs.python.org Python pathlib documentation",
    "site:nodejs.org Node.js HTTP API documentation",
    "site:react.dev React useEffect documentation",
    "site:kubernetes.io Kubernetes deployment documentation",
    "site:docs.docker.com Docker Compose file reference",
    "site:postgresql.org PostgreSQL transaction isolation documentation",
    "site:typescriptlang.org TypeScript narrowing handbook",
];

fn last_tool_text(body: &Value) -> &str {
    let messages = body["messages"].as_array().unwrap();
    messages
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}

fn last_search(body: &Value, step: usize) -> Value {
    let content = last_tool_text(body);
    let (_, data) = content
        .split_once('\n')
        .unwrap_or_else(|| panic!("Expected search results at step {step}, received {content}"));
    serde_json::from_str(data).unwrap()
}

#[tokio::test]
#[ignore = "Uses the live public Exa endpoint with synthetic public search queries"]
async fn pi_reaches_the_live_query_limit_reuses_results_and_resets_for_a_new_task() {
    let group = Group::new().await;
    let step = Arc::new(AtomicUsize::new(0));
    let last_retry = Arc::new(AtomicUsize::new(usize::MAX));
    let retries = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |body| {
        let (next_step, last_retry, retries) = (step.clone(), last_retry.clone(), retries.clone());
        Box::pin(async move {
            let step = next_step.fetch_add(1, Ordering::SeqCst);
            if (1..=12).contains(&step) || step == 16 {
                let result = last_tool_text(&body);
                let retryable = [
                    "公网搜索服务返回了无效响应",
                    "公网搜索超时",
                    "公网搜索服务暂不可用",
                    "上游公网搜索服务暂时限流",
                ]
                .iter()
                .any(|prefix| result.starts_with(prefix));
                if retryable
                    && last_retry.swap(step, Ordering::SeqCst) != step
                    && retries.fetch_add(1, Ordering::SeqCst) < 4
                {
                    eprintln!(
                        "Transient upstream response at step {step}; retrying the same query once."
                    );
                    next_step.store(step, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let query = if step == 16 {
                        QUERIES[0]
                    } else {
                        QUERIES[step - 1]
                    };
                    return call("web_search", json!({"query":query,"limit":2}));
                }
            }
            if (1..=13).contains(&step) || step == 16 {
                let outcome = last_search(&body, step);
                assert_eq!(outcome["provider"], "Exa");
                assert!(!outcome["results"].as_array().unwrap().is_empty());
                assert_eq!(outcome["reusedQuery"], step == 13);
                let expected_remaining = if step == 16 { 11 } else { 12 - step.min(12) };
                assert_eq!(outcome["remainingNewQueries"], expected_remaining);
            }
            match step {
                0..=11 => call("web_search", json!({"query":QUERIES[step],"limit":2})),
                12 | 15 => call("web_search", json!({"query":QUERIES[0],"limit":2})),
                13 => call("web_search", json!({"query":QUERIES[12],"limit":2})),
                14 => {
                    assert!(last_tool_text(&body).contains("本次任务已用完 12 次新查询"));
                    finish(
                        "Twelve distinct queries, one reused result, and the local limit enforced.",
                    )
                }
                16 => finish("The new request started with fresh search capacity."),
                _ => panic!("Unexpected model call after the synthetic verification finished"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Find twelve distinct public documentation sources and check the query limit.",
            "followUp",
            false,
        )
        .await;
    assert!(group.done_within(std::time::Duration::from_secs(120)).await.iter().any(|message| {
        message["status"] == "done"
            && message["content"] == "Twelve distinct queries, one reused result, and the local limit enforced."
    }));
    group
        .send(
            "Start a separate lookup of public Pi documentation.",
            "followUp",
            false,
        )
        .await;
    assert!(group.done().await.iter().any(|message| {
        message["status"] == "done"
            && message["content"] == "The new request started with fresh search capacity."
    }));
    group.close().await;
}
