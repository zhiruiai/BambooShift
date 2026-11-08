use super::*;
use std::future::{pending, ready};
use tokio::sync::Notify;

fn result() -> Vec<SearchResult> {
    vec![SearchResult {
        title: "Search fixture".into(),
        url: "https://example.com/".into(),
        snippet: "Public result".into(),
        published_at: None,
    }]
}

#[tokio::test]
async fn task_supports_twelve_distinct_queries_and_reuses_success_at_the_limit() {
    let budget = WebSearchBudget::default();
    for index in 0..MAX_SEARCHES_PER_TASK {
        let outcome = budget
            .lookup(&format!("query {index}"), 1, ready(Ok(result())))
            .await
            .unwrap();
        assert_eq!(outcome.remaining, MAX_SEARCHES_PER_TASK - index - 1);
        assert!(!outcome.reused);
    }
    let rejected = budget.lookup("new query", 1, pending()).await.unwrap_err();
    assert_eq!(rejected.code, "WEB_SEARCH_TASK_LIMIT");
    let reused = budget.lookup("query 0", 1, pending()).await.unwrap();
    assert!(reused.reused);
    assert_eq!(reused.remaining, 0);
    assert_eq!(&*reused.results, &result());
    let next_task = WebSearchBudget::default();
    let outcome = next_task
        .lookup("query 0", 1, ready(Ok(result())))
        .await
        .unwrap();
    assert_eq!(outcome.remaining, MAX_SEARCHES_PER_TASK - 1);
    assert!(!outcome.reused);
}

#[tokio::test]
async fn upstream_failures_release_query_capacity_but_retries_are_bounded() {
    let budget = WebSearchBudget::default();
    for _ in 0..(MAX_SEARCH_ATTEMPTS - MAX_SEARCHES_PER_TASK) {
        let timeout = ApiError::new(504, "fixture timeout").with_code("WEB_SEARCH_TIMEOUT");
        assert_eq!(
            budget
                .lookup("same query", 1, ready(Err(timeout)))
                .await
                .unwrap_err()
                .code,
            "WEB_SEARCH_TIMEOUT"
        );
    }
    for index in 0..MAX_SEARCHES_PER_TASK {
        let outcome = budget
            .lookup(&format!("working query {index}"), 1, ready(Ok(result())))
            .await
            .unwrap();
        assert_eq!(outcome.remaining, MAX_SEARCHES_PER_TASK - index - 1);
    }

    let unavailable = WebSearchBudget::default();
    for _ in 0..MAX_SEARCH_ATTEMPTS {
        let rate_limit = ApiError::new(429, "provider limit").with_code("WEB_SEARCH_RATE_LIMITED");
        let error = unavailable
            .lookup("same query", 1, ready(Err(rate_limit)))
            .await
            .unwrap_err();
        assert_eq!(error.code, "WEB_SEARCH_RATE_LIMITED");
    }
    let exhausted = unavailable
        .lookup("same query", 1, pending())
        .await
        .unwrap_err();
    assert_eq!(exhausted.code, "WEB_SEARCH_RETRY_LIMIT");
    assert_eq!(exhausted.status.as_u16(), 503);
}

#[tokio::test]
async fn overlapping_queries_share_one_provider_call_and_cancelled_calls_release_capacity() {
    let budget = Arc::new(WebSearchBudget::default());
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let leader = tokio::spawn({
        let (budget, entered, release) = (budget.clone(), entered.clone(), release.clone());
        async move {
            budget
                .lookup("same query", 1, async {
                    entered.notify_one();
                    release.notified().await;
                    Ok(result())
                })
                .await
                .unwrap()
        }
    });
    entered.notified().await;
    let follower = tokio::spawn({
        let budget = budget.clone();
        async move {
            budget
                .lookup("same query", 1, async {
                    panic!("the same in-flight query reached the provider twice")
                })
                .await
                .unwrap()
        }
    });
    release.notify_one();
    assert!(!leader.await.unwrap().reused);
    assert!(follower.await.unwrap().reused);

    let cancelled = tokio::spawn({
        let (budget, entered) = (budget.clone(), entered.clone());
        async move {
            budget
                .lookup("interrupted query", 1, async {
                    entered.notify_one();
                    pending().await
                })
                .await
        }
    });
    entered.notified().await;
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    let retried = budget
        .lookup("interrupted query", 1, ready(Ok(result())))
        .await
        .unwrap();
    assert_eq!(retried.remaining, MAX_SEARCHES_PER_TASK - 2);
}
