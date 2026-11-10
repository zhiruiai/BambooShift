use super::discovery;
use super::model::{self, DesktopSession, Health, SavedRemote, ScreenBinding};
use super::response::read;
use crate::error::{ApiError, Result};
use reqwest::{Client, Method, header::HeaderMap};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, Notify, oneshot, watch};

pub type Authority =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<()>> + Send>> + Send + Sync>;

pub struct Target {
    pub saved: SavedRemote,
    pub workspace_id: String,
    pub binding: Option<ScreenBinding>,
    revision: uuid::Uuid,
    required_origin: Option<String>,
    session: Mutex<Option<DesktopSession>>,
    state: Mutex<Value>,
    client: Client,
    blocked: AtomicBool,
    closed: watch::Sender<bool>,
    queue: Mutex<()>,
    in_flight: AtomicUsize,
    drained: Notify,
    probe: Mutex<Option<Authority>>,
}
pub struct Reply {
    pub status: u16,
    pub headers: HeaderMap,
    pub bytes: Vec<u8>,
}
impl Reply {
    pub fn json(&self) -> Result<Value> {
        serde_json::from_slice(&self.bytes).map_err(|_| model::invalid())
    }
}
#[derive(Clone)]
pub struct Request {
    pub method: Method,
    pub path: String,
    pub body: Vec<u8>,
    pub content_type: &'static str,
    pub max_bytes: usize,
    pub timeout: Duration,
    pub shell_id: Option<String>,
    pub allow_lifecycle_error: bool,
    pub maintenance_screen: Option<(String, String)>,
    pub(super) takeover_lease: Option<String>,
    pub(super) legacy_frame_checked: bool,
}
impl Request {
    pub fn get(path: impl Into<String>) -> Self {
        Self {
            method: Method::GET,
            path: path.into(),
            body: vec![],
            content_type: "application/json",
            max_bytes: model::MAX_RESPONSE,
            timeout: Duration::from_secs(45),
            shell_id: None,
            allow_lifecycle_error: false,
            maintenance_screen: None,
            takeover_lease: None,
            legacy_frame_checked: false,
        }
    }
    pub fn post(path: impl Into<String>, body: &Value) -> Self {
        Self {
            method: Method::POST,
            body: serde_json::to_vec(body).unwrap(),
            ..Self::get(path)
        }
    }
}
impl Target {
    pub async fn discover(
        url: &str,
        token: &str,
        workspace: &str,
        origin: Option<&str>,
        binding: Option<ScreenBinding>,
        expected: Option<&SavedRemote>,
        authorize: Authority,
    ) -> Result<Arc<Self>> {
        let (client, health) = discovery::discover(
            url,
            token,
            workspace,
            origin,
            binding.as_ref(),
            expected,
            &authorize,
        )
        .await?;
        let (closed, _) = watch::channel(false);
        Ok(Arc::new(Self {
            saved: health.saved,
            workspace_id: workspace.into(),
            binding,
            revision: uuid::Uuid::new_v4(),
            required_origin: origin.map(str::to_owned),
            session: Mutex::new(health.session),
            state: Mutex::new(health.state),
            client,
            blocked: AtomicBool::new(false),
            closed,
            queue: Mutex::new(()),
            in_flight: AtomicUsize::new(0),
            drained: Notify::new(),
            probe: Mutex::new(None),
        }))
    }
    pub fn is_blocked(&self) -> bool {
        self.blocked.load(Ordering::Acquire)
    }
    pub async fn set_probe(&self, probe: Option<Authority>) {
        *self.probe.lock().await = probe;
    }
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }
    pub fn active_count(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }
    pub fn active(&self) -> Result<()> {
        if self.is_blocked() {
            return Err(model::blocked());
        }
        if self.is_closed() {
            return Err(model::invalid());
        }
        Ok(())
    }
    pub fn poison(&self) {
        self.blocked.store(true, Ordering::Release);
        self.closed.send_replace(true);
    }
    pub async fn state(&self) -> Value {
        let mut state = self.state.lock().await.clone();
        state["targetRevision"] = json!(self.revision.to_string());
        if self.is_closed() || self.is_blocked() {
            state["connected"] = json!(false);
            state["status"] = json!(if self.is_blocked() {
                "操作清理尚未确认，请维护画面。"
            } else {
                "连接已断开。"
            });
        }
        state
    }
    pub async fn close(&self) {
        self.closed.send_replace(true);
        self.wait_idle().await;
    }
    pub(super) async fn wait_idle(&self) {
        loop {
            let wait = self.drained.notified();
            if self.active_count() == 0 {
                break;
            }
            wait.await;
        }
    }
    async fn headers(&self, request: &Request, operation: Option<&str>) -> reqwest::RequestBuilder {
        let prefix = self
            .binding
            .as_ref()
            .map(|b| format!("/screens/{}", b.screen_id))
            .unwrap_or_default();
        let mut builder = self
            .client
            .request(
                request.method.clone(),
                format!("{}{prefix}{}", self.saved.url, request.path),
            )
            .bearer_auth(&self.saved.token)
            .header("Content-Type", request.content_type)
            .header("X-OpenBot-Worker-Instance", &self.saved.instance_id)
            .header(
                "X-OpenBot-Control-Origin",
                self.saved.control_origin.as_deref().unwrap_or("none"),
            )
            .header("X-OpenBot-Workspace-Scope", &self.workspace_id)
            .timeout(request.timeout);
        if let Some(binding) = &self.binding {
            builder = builder.header("X-OpenBot-Screen-Id", &binding.screen_id);
            if let Some(revision) = &binding.screen_revision {
                builder = builder.header("X-OpenBot-Screen-Revision", revision);
            }
        }
        if let Some((id, revision)) = &request.maintenance_screen {
            builder = builder
                .header("X-OpenBot-Screen-Id", id)
                .header("X-OpenBot-Screen-Revision", revision);
        }
        if request.path != "/health" {
            if let Some(session) = self.session.lock().await.as_ref() {
                builder = builder
                    .header("X-OpenBot-Desktop-Session", &session.id)
                    .header("X-OpenBot-Desktop-Generation", &session.generation);
            }
        }
        if let Some(id) = operation {
            builder = builder.header("X-OpenBot-Operation-Id", id);
        }
        if let Some(id) = &request.shell_id {
            builder = builder.header("X-OpenBot-Action-Id", id);
        }
        if let Some(lease) = &request.takeover_lease {
            builder = builder.header("X-OpenBot-Computer-Lease", lease);
        }
        builder.body(request.body.clone())
    }
    async fn wire(&self, request: &Request, operation: Option<&str>) -> Result<Reply> {
        if let Some(probe) = self.probe.lock().await.clone() {
            probe().await?;
        }
        self.wire_inner(request, operation).await
    }
    async fn wire_cleanup(&self, request: &Request) -> Result<Reply> {
        if request.method != reqwest::Method::POST
            || !matches!(
                request.path.as_str(),
                "/operations/cancel" | "/shell/cancel" | "/takeover/end"
            )
        {
            return Err(model::invalid());
        }
        self.wire_inner(request, None).await
    }
    async fn wire_inner(&self, request: &Request, operation: Option<&str>) -> Result<Reply> {
        let reply = read(
            self.headers(request, operation)
                .await
                .send()
                .await
                .map_err(|_| ApiError::new(502, "电脑连接未返回结果。"))?,
            request.max_bytes,
        )
        .await?;
        if !(200..300).contains(&reply.status)
            && !(request.allow_lifecycle_error && reply.status == 409)
        {
            let error = reply.json().unwrap_or_default();
            if reply.status == 409
                && request.path == "/screenshot"
                && error["code"] == "COMPUTER_PRIVATE_TAKEOVER"
            {
                return Err(model::private_takeover());
            }
            if error["code"] == "WORKER_CONNECTION_INVALID" {
                self.poison();
            }
            return Err(ApiError::new(
                if reply.status == 404 { 404 } else { 409 },
                "远程电脑未能完成此请求，请核对当前状态。",
            ));
        }
        Ok(reply)
    }
    async fn preflight(&self) -> Result<Health> {
        let mut request = Request::get("/health");
        request.max_bytes = 64 * 1024;
        request.timeout = Duration::from_secs(8);
        let value = self.wire(&request, None).await?.json()?;
        let previous = self.session.lock().await.clone();
        let checked = model::health(
            value,
            &self.saved.url,
            &self.saved.token,
            &self.workspace_id,
            self.required_origin.as_deref(),
            Some(&self.saved),
            self.binding.as_ref(),
            previous.as_ref(),
        )?;
        *self.session.lock().await = checked.session.clone();
        *self.state.lock().await = checked.state.clone();
        Ok(checked)
    }
    pub async fn request(
        self: &Arc<Self>,
        request: Request,
        authorize: Authority,
    ) -> Result<Reply> {
        self.active()?;
        if !request.path.starts_with('/')
            || request.path.contains('#')
            || request.path.starts_with("//")
            || request
                .path
                .split('?')
                .next()
                .unwrap_or("")
                .split('/')
                .any(|s| s == ".." || s == ".")
            || request.body.len() > model::MAX_RESPONSE
        {
            return Err(ApiError::bad("电脑请求无效。"));
        }
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        let target = self.clone();
        let (mut sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let result = target.supervise(request, authorize, &mut sender).await;
            let _ = sender.send(result);
            target.in_flight.fetch_sub(1, Ordering::AcqRel);
            target.drained.notify_waiters();
        });
        receiver.await.map_err(|_| model::blocked())?
    }
    async fn supervise(
        &self,
        request: Request,
        authorize: Authority,
        sender: &mut oneshot::Sender<Result<Reply>>,
    ) -> Result<Reply> {
        let mut closed = self.closed.subscribe();
        let _queue = tokio::select! {
            guard=self.queue.lock()=>guard,
            _=sender.closed()=>return Err(model::invalid()),
            _=closed.changed()=>return Err(model::invalid()),
        };
        self.active()?;
        authorize().await?;
        let preflight = tokio::select! {
            result=self.preflight()=>result,
            _=sender.closed()=>return Err(model::invalid()),
            _=closed.changed()=>return Err(model::invalid()),
        };
        if preflight.is_err() {
            self.poison();
        }
        super::takeover_frames::worker_access(&request, &preflight?.saved.capabilities)?;
        self.active()?;
        authorize().await?;
        if request.path == "/health" {
            return Ok(Reply {
                status: 200,
                headers: HeaderMap::new(),
                bytes: serde_json::to_vec(&*self.state.lock().await).unwrap(),
            });
        }
        let tracked = matches!(
            request.path.split('?').next(),
            Some(
                "/screenshot"
                    | "/execute"
                    | "/execute-with-frame"
                    | "/takeover/input"
                    | "/files/content"
            )
        );
        let shell = request.shell_id.clone();
        if tracked
            && shell.is_none()
            && !self.saved.capabilities.iter().any(|c| c == model::CLEANUP)
        {
            return Err(ApiError::new(
                409,
                "电脑尚不支持可确认的操作清理，请升级后重新连接。",
            ));
        }
        let operation = (tracked && shell.is_none()).then(|| uuid::Uuid::new_v4().to_string());
        let result = {
            let work = self.wire(&request, operation.as_deref());
            tokio::pin!(work);
            let mut checks = tokio::time::interval(Duration::from_millis(200));
            loop {
                tokio::select! {
                    result=&mut work=>break result,
                    _=sender.closed()=>break Err(ApiError::new(409,"请求已取消；正在核对电脑状态。")),
                    _=closed.changed()=>break Err(model::invalid()),
                    _=checks.tick()=>{ if let Err(error)=authorize().await { break Err(error); } },
                }
            }
        };
        if let Some(id) = operation.as_deref().or(shell.as_deref()) {
            let cleanup = Request::post(
                if shell.is_some() {
                    "/shell/cancel"
                } else {
                    "/operations/cancel"
                },
                &json!({"id":id}),
            );
            let confirmed = self
                .wire_cleanup(&cleanup)
                .await
                .and_then(|reply| reply.json())
                .is_ok_and(|v| {
                    v["stopped"] == true
                        && (shell.is_some() || (v["id"] == id && v["cleanupConfirmed"] == true))
                });
            if !confirmed {
                self.poison();
                return Err(model::blocked());
            }
        }
        if request.path == "/takeover/start" && result.is_err() {
            self.poison();
            return Err(model::blocked());
        }
        if request.path == "/takeover/start"
            && (sender.is_closed() || self.is_closed() || authorize().await.is_err())
        {
            if let Ok(reply) = &result {
                if let Some(lease) = reply
                    .json()
                    .ok()
                    .and_then(|v| v["leaseId"].as_str().map(str::to_owned))
                {
                    if self
                        .wire_cleanup(&Request::post("/takeover/end", &json!({"leaseId":lease})))
                        .await
                        .is_err()
                    {
                        self.poison();
                        return Err(model::blocked());
                    }
                } else {
                    self.poison();
                    return Err(model::blocked());
                }
            }
            return Err(model::invalid());
        }
        self.active()?;
        authorize().await?;
        result
    }
}
