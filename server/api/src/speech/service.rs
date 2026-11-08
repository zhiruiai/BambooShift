use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::WorkspaceAccess,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, watch};

pub(super) struct Job {
    pub cancel: watch::Sender<bool>,
    done: AtomicBool,
    changed: Notify,
}
pub struct SpeechService {
    slots: Arc<Semaphore>,
    processor: Semaphore,
    users: Mutex<HashSet<String>>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    closed: AtomicBool,
}
impl Default for SpeechService {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(5)),
            processor: Semaphore::new(1),
            users: Mutex::new(HashSet::new()),
            jobs: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }
}
pub(super) struct Lease {
    service: Arc<SpeechService>,
    id: String,
    user: String,
    pub job: Arc<Job>,
    _slot: OwnedSemaphorePermit,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.service.users.lock().unwrap().remove(&self.user);
        self.service.jobs.lock().unwrap().remove(&self.id);
        self.job.done.store(true, Ordering::Release);
        self.job.changed.notify_waiters();
    }
}
pub(super) struct CancelGuard {
    pub job: Arc<Job>,
}
pub(super) struct AudioClip {
    pub bytes: Vec<u8>,
    pub duration_ms: u64,
    pub voice_call: Option<String>,
}
impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.job.cancel.send_replace(true);
    }
}
impl SpeechService {
    pub(super) fn reserve(self: &Arc<Self>, user: &str) -> Result<Lease> {
        if self.closed.load(Ordering::Acquire) {
            return Err(super::config::unavailable());
        }
        let mut users = self.users.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return Err(super::config::unavailable());
        }
        if users.contains(user) {
            return Err(
                ApiError::new(409, "你已有一条听写正在处理。").with_code("SPEECH_ALREADY_PENDING")
            );
        }
        let slot = self.slots.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(429, "语音识别正在处理其他请求。").with_code("SPEECH_BUSY")
        })?;
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel, _) = watch::channel(false);
        let job = Arc::new(Job {
            cancel,
            done: AtomicBool::new(false),
            changed: Notify::new(),
        });
        users.insert(user.to_owned());
        self.jobs.lock().unwrap().insert(id.clone(), job.clone());
        Ok(Lease {
            service: self.clone(),
            id,
            user: user.to_owned(),
            job,
            _slot: slot,
        })
    }
    pub async fn close(&self) {
        let jobs = {
            let _users = self.users.lock().unwrap();
            self.closed.store(true, Ordering::Release);
            self.jobs
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect::<Vec<_>>()
        };
        for job in &jobs {
            job.cancel.send_replace(true);
        }
        for job in jobs {
            loop {
                let changed = job.changed.notified();
                if job.done.load(Ordering::Acquire) {
                    break;
                }
                changed.await;
            }
        }
    }
    pub(super) async fn run(
        state: State,
        grant: WorkspaceAccess,
        lease: Lease,
        config: super::config::Config,
        clip: AudioClip,
    ) -> Result<Value> {
        let mut cancel = lease.job.cancel.subscribe();
        if *cancel.borrow() {
            return Err(cancelled());
        }
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(30));
        tokio::pin!(deadline);
        let waiting = lease.service.processor.acquire();
        tokio::pin!(waiting);
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        let _processor = loop {
            tokio::select! {permit=&mut waiting=>break permit.map_err(|_|super::config::unavailable())?,_=cancel.changed()=>return Err(cancelled()),_=&mut deadline=>return Err(ApiError::new(503,"语音识别等待超时。").with_code("SPEECH_QUEUE_TIMEOUT")),_=interval.tick()=>{grant.authorize(&state).await?;if state.is_closing(){return Err(cancelled());}}}
        };
        grant.authorize(&state).await?;
        if *cancel.borrow() {
            return Err(cancelled());
        }
        if let Some(id) = clip.voice_call.as_deref() {
            super::calls::check_audio(&state, &grant, id).await?;
        }
        let root = state.config.data_dir.join("speech").join("temporary");
        private_directory(&root)?;
        let directory = root.join(uuid::Uuid::new_v4().to_string());
        private_directory(&directory)?;
        let result = execute(&state, &grant, &config, &directory, &clip, &mut cancel).await;
        let _ = tokio::fs::remove_dir_all(&directory).await;
        grant.authorize(&state).await?;
        if *cancel.borrow() {
            return Err(cancelled());
        }
        if let Some(id) = clip.voice_call.as_deref() {
            super::calls::check_audio(&state, &grant, id).await?;
        }
        result.map(|text| json!({"text":text,"durationMs":clip.duration_ms,"userId":grant.user_id}))
    }
}
fn private_directory(path: &std::path::Path) -> Result<()> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(super::config::unavailable());
        }
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn cancelled() -> ApiError {
    ApiError::new(409, "听写已取消。").with_code("SPEECH_CANCELLED")
}
async fn execute(
    state: &State,
    grant: &WorkspaceAccess,
    config: &super::config::Config,
    directory: &std::path::Path,
    clip: &AudioClip,
    cancel: &mut watch::Receiver<bool>,
) -> Result<String> {
    let input = directory.join("audio.wav");
    let output = directory.join("result");
    let output_file = output.with_extension("json");
    private_write(&input, &clip.bytes)?;
    private_write(&output_file, b"")?;
    let mut command = tokio::process::Command::new(&config.binary_path);
    command
        .args(["-m"])
        .arg(if clip.voice_call.is_some() {
            config.voice_model()?
        } else {
            &config.model_path
        })
        .arg("-f")
        .arg(&input)
        .args(["-l", "auto", "-t"])
        .arg(config.threads.to_string())
        .args(["-p", "1", "--no-gpu", "-oj", "-of"])
        .arg(&output)
        .arg("-np")
        .current_dir(directory)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "en_US.UTF-8")
        .env("TMPDIR", directory)
        .env("VECLIB_MAXIMUM_THREADS", config.threads.to_string())
        .env("OMP_NUM_THREADS", config.threads.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if clip.voice_call.is_some() {
        // Whisper encodes one frame per 20 ms. Keep one second of trailing context.
        let context = ((clip.duration_ms + 1000).div_ceil(320) * 16).clamp(192, 1500);
        command
            .args(["--no-fallback", "-bo", "1", "-bs", "1", "-ac"])
            .arg(context.to_string());
    }
    let mut child = command.spawn().map_err(|_| super::config::unavailable())?;
    let mut check = tokio::time::interval(std::time::Duration::from_millis(200));
    let mut call_check = tokio::time::interval(std::time::Duration::from_secs(1));
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(120));
    tokio::pin!(deadline);
    let result = loop {
        tokio::select! {
            status=child.wait()=>break match status{Ok(status) if status.success()=>Ok(()),_=>Err(ApiError::new(502,"语音识别未完成，请重新录制。").with_code("SPEECH_FAILED"))},
            _=cancel.changed()=>break Err(cancelled()),
            _=&mut deadline=>break Err(ApiError::new(504,"语音识别超时，请缩短录音。").with_code("SPEECH_TIMEOUT")),
            _=check.tick()=>{if *cancel.borrow()||state.is_closing(){break Err(cancelled());}if grant.authorize(state).await.is_err(){break Err(ApiError::new(403,"账户权限已失效。").with_code("SPEECH_ACCESS_REVOKED"));}if std::fs::metadata(&output_file).is_ok_and(|m|m.len()>65536){break Err(ApiError::new(502,"语音识别结果过大。").with_code("SPEECH_INVALID_RESULT"));}},
            _=call_check.tick(), if clip.voice_call.is_some()=>{
                if let Some(id) = clip.voice_call.as_deref() {
                    if let Err(error) = super::calls::check_audio(state, grant, id).await {break Err(error);}
                }
            },
        }
    };
    if result.is_err() {
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
    result?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(output_file)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 65536 {
        return Err(ApiError::new(502, "语音识别结果无效。").with_code("SPEECH_INVALID_RESULT"));
    }
    let mut bytes = vec![];
    file.by_ref().take(65537).read_to_end(&mut bytes)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new(502, "语音识别结果无效。").with_code("SPEECH_INVALID_RESULT"))?;
    let parts = value["transcription"]
        .as_array()
        .ok_or_else(|| ApiError::new(502, "语音识别结果无效。"))?;
    let text = parts
        .iter()
        .map(|part| {
            part["text"]
                .as_str()
                .ok_or_else(|| ApiError::new(502, "语音识别结果无效。"))
        })
        .collect::<Result<String>>()?;
    let text = text.trim();
    if text.is_empty() {
        return Err(
            ApiError::new(422, "没有识别出文字，请靠近麦克风再试。").with_code("SPEECH_EMPTY")
        );
    }
    if text.encode_utf16().count() > 8000 {
        return Err(ApiError::new(502, "语音识别结果过长。").with_code("SPEECH_INVALID_RESULT"));
    }
    Ok(text.to_owned())
}
fn private_write(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)?;
    Ok(())
}
