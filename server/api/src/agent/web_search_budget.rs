use super::web_search::SearchResult;
use crate::error::{ApiError, Result};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::OnceCell;

pub(super) const MAX_SEARCHES_PER_TASK: usize = 12;
const MAX_SEARCH_ATTEMPTS: usize = MAX_SEARCHES_PER_TASK + 4;

type SearchKey = (String, usize);
type CachedSearch = Arc<OnceCell<Arc<[SearchResult]>>>;

#[derive(Default)]
pub(super) struct WebSearchBudget {
    state: Mutex<SearchState>,
}

#[derive(Default)]
struct SearchState {
    queries: HashMap<SearchKey, CachedSearch>,
    attempts: usize,
    // Successful lookups keep a slot. Failed or cancelled lookups release it.
    reserved: usize,
}

#[derive(Debug)]
pub(super) struct SearchOutcome {
    pub results: Arc<[SearchResult]>,
    pub reused: bool,
    pub remaining: usize,
}

struct SearchPermit<'a> {
    state: &'a Mutex<SearchState>,
    completed: bool,
}

impl Drop for SearchPermit<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.state.lock().unwrap().reserved -= 1;
        }
    }
}

fn check_budget(state: &SearchState) -> Result<()> {
    if state.reserved >= MAX_SEARCHES_PER_TASK {
        return Err(ApiError::new(
            429,
            format!("本次任务已用完 {MAX_SEARCHES_PER_TASK} 次新查询。可使用已有来源或在新任务中继续检索。"),
        )
        .with_code("WEB_SEARCH_TASK_LIMIT"));
    }
    if state.attempts >= MAX_SEARCH_ATTEMPTS {
        return Err(ApiError::new(
            503,
            "本次任务的搜索服务重试次数已用完。请稍后重新发起检索。",
        )
        .with_code("WEB_SEARCH_RETRY_LIMIT"));
    }
    Ok(())
}

impl WebSearchBudget {
    pub(super) async fn lookup(
        &self,
        query: &str,
        limit: usize,
        fetch: impl Future<Output = Result<Vec<SearchResult>>>,
    ) -> Result<SearchOutcome> {
        let key = (query.to_owned(), limit);
        let entry = {
            let mut state = self.state.lock().unwrap();
            if let Some(entry) = state.queries.get(&key) {
                entry.clone()
            } else {
                check_budget(&state)?;
                if state.queries.len() >= MAX_SEARCH_ATTEMPTS {
                    return Err(ApiError::new(503, "本次任务有过多未完成的网页搜索。")
                        .with_code("WEB_SEARCH_RETRY_LIMIT"));
                }
                state.queries.entry(key).or_default().clone()
            }
        };
        let mut reused = true;
        let results = entry
            .get_or_try_init(|| {
                reused = false;
                async {
                    let mut permit = self.reserve()?;
                    let results = fetch.await?;
                    permit.completed = true;
                    Ok::<_, ApiError>(Arc::from(results))
                }
            })
            .await?
            .clone();
        let remaining = MAX_SEARCHES_PER_TASK - self.state.lock().unwrap().reserved;
        Ok(SearchOutcome {
            results,
            reused,
            remaining,
        })
    }

    fn reserve(&self) -> Result<SearchPermit<'_>> {
        let mut state = self.state.lock().unwrap();
        check_budget(&state)?;
        state.attempts += 1;
        state.reserved += 1;
        Ok(SearchPermit {
            state: &self.state,
            completed: false,
        })
    }
}

#[cfg(test)]
#[path = "web_search_budget_tests.rs"]
mod tests;
