use crate::error::{ApiError, Result};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, watch};
#[derive(Default)]
pub struct TeamBuilderJobs {
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
    closed: AtomicBool,
    done: Notify,
}
pub struct Lease {
    jobs: Arc<TeamBuilderJobs>,
    id: String,
    pub cancelled: watch::Receiver<bool>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.jobs.active.lock().unwrap().remove(&self.id);
        self.jobs.done.notify_waiters();
    }
}
impl TeamBuilderJobs {
    pub fn reserve(self: &Arc<Self>, id: &str) -> Result<Lease> {
        let mut active = self.active.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(503, "团队规划服务正在关闭。"));
        }
        if !active.is_empty() {
            return Err(ApiError::new(
                409,
                "当前空间已有方案正在生成，请先等待或取消。",
            ));
        }
        let (send, cancelled) = watch::channel(false);
        active.insert(id.to_owned(), send);
        Ok(Lease {
            jobs: self.clone(),
            id: id.to_owned(),
            cancelled,
        })
    }
    pub fn cancel(&self, id: &str) {
        if let Some(job) = self.active.lock().unwrap().get(id) {
            let _ = job.send(true);
        }
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        loop {
            let done = self.done.notified();
            {
                let active = self.active.lock().unwrap();
                if active.is_empty() {
                    return;
                }
                for job in active.values() {
                    let _ = job.send(true);
                }
            }
            done.await;
        }
    }
}
