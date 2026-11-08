use super::{WorkspaceAccess, WorkspaceStore};
use crate::{
    db::State,
    error::{ApiError, Result},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, OwnedSemaphorePermit, Semaphore, oneshot},
};

static GLOBAL: OnceLock<Arc<Semaphore>> = OnceLock::new();
pub struct AvatarJobs {
    active: Mutex<HashMap<String, Arc<Cancellation>>>,
    closed: AtomicBool,
    settled: Notify,
}
pub struct Cancellation {
    cancelled: AtomicBool,
    notify: Notify,
}
pub struct Lease {
    owner: Arc<AvatarJobs>,
    id: String,
    cancellation: Arc<Cancellation>,
    _capacity: OwnedSemaphorePermit,
}
struct RequestGuard(Arc<Cancellation>);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.owner.active.lock().unwrap().remove(&self.id);
        self.owner.settled.notify_waiters();
    }
}
impl Default for AvatarJobs {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            settled: Notify::new(),
        }
    }
}
impl AvatarJobs {
    pub fn reserve(self: &Arc<Self>) -> Result<Lease> {
        let mut active = self.active.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(503, "头像服务正在关闭。"));
        }
        if !active.is_empty() {
            return Err(ApiError::new(429, "当前空间正在处理头像，请稍后重试。"));
        }
        let capacity = GLOBAL
            .get_or_init(|| Arc::new(Semaphore::new(2)))
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::new(429, "头像处理繁忙，请稍后重试。"))?;
        let cancellation = Arc::new(Cancellation {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        });
        let id = uuid::Uuid::new_v4().to_string();
        active.insert(id.clone(), cancellation.clone());
        Ok(Lease {
            owner: self.clone(),
            id,
            cancellation,
            _capacity: capacity,
        })
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        loop {
            let notified = self.settled.notified();
            {
                let active = self.active.lock().unwrap();
                if active.is_empty() {
                    return;
                }
                for job in active.values() {
                    job.cancel();
                }
            }
            notified.await;
        }
    }
}
impl Lease {
    pub async fn run<T: Send + 'static, F: Future<Output = Result<T>> + Send + 'static>(
        self,
        operation: impl FnOnce(Arc<Cancellation>) -> F + Send + 'static,
    ) -> Result<T> {
        let cancellation = self.cancellation.clone();
        let _guard = RequestGuard(cancellation.clone());
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let result = operation(cancellation).await;
            drop(self);
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| ApiError::new(503, "头像处理已中断。"))?
    }
}
impl Cancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(ApiError::new(409, "头像操作已取消。"));
        }
        Ok(())
    }
    pub async fn authorize(&self, state: &State, grant: &WorkspaceAccess) -> Result<()> {
        self.check()?;
        grant.authorize(state).await?;
        self.check()
    }
    pub async fn guard<T>(
        &self,
        state: &State,
        grant: &WorkspaceAccess,
        seconds: u64,
        future: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let cancellation = self.notify.notified();
        self.authorize(state, grant).await?;
        let timer = tokio::time::sleep(Duration::from_secs(seconds));
        let mut interval = tokio::time::interval(Duration::from_millis(200));
        let mut changes = state.subscribe_security();
        tokio::pin!(future, timer, cancellation);
        loop {
            tokio::select! {
                result = &mut future => { self.authorize(state, grant).await?; return result; }
                _ = &mut cancellation => { return Err(ApiError::new(409, "头像操作已取消。")); }
                _ = &mut timer => { return Err(ApiError::new(408, "头像处理超时，请换一张图片重试。")); }
                _ = interval.tick() => { self.authorize(state, grant).await?; }
                _ = changes.recv() => { self.authorize(state, grant).await?; }
            }
        }
    }
}
fn executable() -> Result<PathBuf> {
    let current = std::env::current_exe()?;
    let directory = current
        .parent()
        .ok_or_else(|| ApiError::new(503, "图片处理程序不可用。"))?;
    let mut path = directory.join("openbot-image-worker");
    if directory.file_name().is_some_and(|v| v == "deps") {
        path = directory.parent().unwrap().join("openbot-image-worker");
    }
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| ApiError::new(503, "图片处理程序不可用。"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ApiError::new(503, "图片处理程序不可用。"));
    }
    Ok(path)
}
pub async fn process(
    job: &Cancellation,
    state: &State,
    grant: &WorkspaceAccess,
    input: Value,
) -> Result<Value> {
    job.authorize(state, grant).await?;
    let bytes = serde_json::to_vec(&input).map_err(|_| ApiError::bad("头像图片无效。"))?;
    let child = tokio::process::Command::new(executable()?)
        .env_clear()
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ApiError::new(503, "图片处理程序暂不可用。"))?;
    process_child(job, state, grant, child, bytes).await
}
async fn process_child(
    job: &Cancellation,
    state: &State,
    grant: &WorkspaceAccess,
    mut child: tokio::process::Child,
    payload: Vec<u8>,
) -> Result<Value> {
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let write = tokio::spawn(async move {
        stdin.write_all(&payload).await?;
        stdin.shutdown().await
    });
    let read = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take(3 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let status = job
        .guard(state, grant, 10, async { Ok(child.wait().await?) })
        .await;
    if status.is_err() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    let written = write.await;
    let bytes = read.await;
    let status = status?;
    if !status.success() || !matches!(written, Ok(Ok(()))) {
        return Err(ApiError::bad("头像图片无法完成处理，请换一张图片重试。"));
    }
    let bytes = bytes.map_err(|_| ApiError::bad("头像图片处理失败。"))??;
    if bytes.len() > 3 * 1024 * 1024 {
        return Err(ApiError::new(413, "头像预览过大。"));
    }
    let envelope: Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("头像图片处理失败。"))?;
    if envelope["ok"] != true {
        return Err(match envelope["error"].as_str() {
            Some("too_large") => ApiError::new(
                413,
                "头像图片过大，请选择小于 25 MiB、最多 4,000 万像素的图片。",
            ),
            Some("crop") => ApiError::bad("裁剪区域超出了原图边界。"),
            _ => ApiError::bad("请上传有效的 PNG、JPEG 或 WebP 静态图片。"),
        });
    }
    job.authorize(state, grant).await?;
    Ok(envelope["result"].clone())
}

pub async fn active(store: &WorkspaceStore) -> Result<Lease> {
    if store.is_closed() {
        return Err(ApiError::new(503, "工作空间服务正在关闭。"));
    }
    store.avatar_jobs.reserve()
}

#[cfg(test)]
#[path = "avatar_jobs_tests.rs"]
mod tests;
