pub(crate) mod calls;
mod config;
pub(crate) mod memo_synthesis;
mod service;
mod wav;
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::access,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State as Extract},
    http::HeaderMap,
    routing::{get, post},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
pub use service::SpeechService;

pub fn router() -> Router<State> {
    Router::new()
        .route("/api/workspaces/{wid}/speech/status", get(status))
        .route("/api/workspaces/{wid}/speech/transcribe", post(transcribe))
        .layer(DefaultBodyLimit::disable())
        .merge(calls::router())
}
async fn status(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, false).await?;
    grant.authorize(&state).await?;
    let available = !state.is_closing() && config::read(&state.config.data_dir).is_ok();
    let mut status = json!({"available":available,"maxSeconds":60,"maxBytes":wav::MAX_BYTES,"format":"wav-pcm16-mono-16000","processing":"server-local"});
    if !available {
        status["reason"] = json!("服务器尚未启用可用的本地语音识别。");
    }
    Ok(Json(status))
}
async fn transcribe(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let voice_call = headers
        .get("x-openbot-voice-call")
        .map(|value| calls::id(value.to_str().map_err(|_| calls::invalid())?).map(str::to_owned))
        .transpose()?;
    if let Some(id) = voice_call.as_deref() {
        calls::check_audio(&state, &grant, id).await?;
    }
    if !header("content-type").is_some_and(|v| v.trim().eq_ignore_ascii_case("audio/wav"))
        || header("content-encoding").is_some_and(|v| v != "identity")
    {
        return Err(
            ApiError::new(415, "请上传未压缩的WAV录音。").with_code("SPEECH_UNSUPPORTED_FORMAT")
        );
    }
    if header("content-length").is_some_and(|length| {
        length
            .parse::<usize>()
            .ok()
            .is_none_or(|size| size > wav::MAX_BYTES)
    }) {
        return Err(ApiError::new(413, "录音文件不能超过2MiB。").with_code("SPEECH_TOO_LARGE"));
    }
    let config = config::read(&state.config.data_dir)?;
    let lease = state.speech.reserve(&grant.user_id)?;
    let cancel_guard = service::CancelGuard {
        job: lease.job.clone(),
    };
    let mut cancel = lease.job.cancel.subscribe();
    let mut stream = request.into_body().into_data_stream();
    let mut bytes = vec![];
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(15));
    tokio::pin!(deadline);
    let mut security = state.subscribe_security();
    let mut check = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tokio::select! {
            frame=stream.next()=>{match frame {Some(Ok(part))=>{if bytes.len()+part.len()>wav::MAX_BYTES{return Err(ApiError::new(413,"录音文件不能超过2MiB。").with_code("SPEECH_TOO_LARGE"));}bytes.extend_from_slice(&part);},Some(Err(_))=>return Err(ApiError::new(409,"录音上传已中断。").with_code("SPEECH_CANCELLED")),None=>break,}},
            _=&mut deadline=>return Err(ApiError::new(408,"录音上传超时。").with_code("SPEECH_UPLOAD_TIMEOUT")),
            _=cancel.changed()=>return Err(ApiError::new(409,"听写已取消。").with_code("SPEECH_CANCELLED")),
            _=security.recv()=>{grant.authorize(&state).await?;if state.is_closing(){return Err(config::unavailable());}},
            _=check.tick()=>{grant.authorize(&state).await?;if state.is_closing(){return Err(config::unavailable());}},
        }
    }
    grant.authorize(&state).await?;
    let (audio, duration) = wav::parse(&bytes)?;
    drop(bytes);
    let (send, result) = tokio::sync::oneshot::channel();
    let worker_state = state.clone();
    let worker_grant = grant.clone();
    tokio::spawn(async move {
        let clip = service::AudioClip {
            bytes: audio,
            duration_ms: duration,
            voice_call,
        };
        let result = SpeechService::run(worker_state, worker_grant, lease, config, clip).await;
        let _ = send.send(result);
    });
    let result = result.await.map_err(|_| config::unavailable())??;
    grant.authorize(&state).await?;
    drop(cancel_guard);
    Ok(Json(result))
}
