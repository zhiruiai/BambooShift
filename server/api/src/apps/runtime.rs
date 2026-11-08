use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::WorkspaceAccess,
};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Mutex, Notify, Semaphore};

pub type Authority =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<()>> + Send>> + Send + Sync>;
pub fn user_authority(state: &State, access: &WorkspaceAccess) -> Authority {
    let state = state.clone();
    let access = access.clone();
    Arc::new(move || {
        let state = state.clone();
        let access = access.clone();
        Box::pin(async move { access.authorize(&state).await })
    })
}
pub struct AppsRuntime {
    pub(crate) fixture_origins: Vec<String>,
    pub(crate) jobs: Mutex<HashMap<String, Arc<super::actions::Job>>>,
    pub(crate) locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    closed: AtomicBool,
    pub(crate) slots: Semaphore,
    workers: AtomicUsize,
    drained: Notify,
}
impl Default for AppsRuntime {
    fn default() -> Self {
        Self {
            fixture_origins: vec![],
            jobs: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            slots: Semaphore::new(16),
            workers: AtomicUsize::new(0),
            drained: Notify::new(),
        }
    }
}
impl AppsRuntime {
    /// Constructor-only local protocol fixtures; never loaded from HTTP or environment.
    pub fn fixture(origins: Vec<String>) -> Result<Self> {
        for origin in &origins {
            let url =
                url::Url::parse(origin).map_err(|_| ApiError::bad("Invalid fixture origin"))?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.origin().ascii_serialization() != *origin
            {
                return Err(ApiError::bad("Invalid fixture origin"));
            }
        }
        Ok(Self {
            fixture_origins: origins,
            ..Self::default()
        })
    }
    pub(crate) async fn lock(&self, key: &str) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .await
            .entry(key.into())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
    pub fn active(&self) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            Err(ApiError::new(503, "应用服务正在关闭。"))
        } else {
            Ok(())
        }
    }
    pub(crate) fn enter(self: &Arc<Self>) -> Result<WorkerLease> {
        self.workers.fetch_add(1, Ordering::SeqCst);
        let lease = WorkerLease(self.clone());
        self.active()?;
        Ok(lease)
    }
    pub async fn close(&self, state: &State) {
        self.closed.store(true, Ordering::SeqCst);
        let jobs: Vec<_> = self
            .jobs
            .lock()
            .await
            .iter()
            .map(|(id, job)| (id.clone(), job.clone()))
            .collect();
        for (id, job) in jobs {
            let _ =
                super::actions::cancel(state, &job.recipient, &id, "服务正在关闭，原审批已失效。")
                    .await;
        }
        loop {
            let notified = self.drained.notified();
            if self.workers.load(Ordering::SeqCst) == 0 {
                break;
            }
            notified.await;
        }
    }
}

pub(crate) struct WorkerLease(Arc<AppsRuntime>);
impl Drop for WorkerLease {
    fn drop(&mut self) {
        self.0.workers.fetch_sub(1, Ordering::SeqCst);
        self.0.drained.notify_waiters();
    }
}
