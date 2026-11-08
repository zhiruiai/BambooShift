#![allow(dead_code)]
use crate::workspace_support::Fixture;
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use serde_json::{Value, json};
use tower::ServiceExt;
pub fn wav() -> Vec<u8> {
    let mut bytes = vec![];
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&38u32.to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&16000u32.to_le_bytes());
    bytes.extend_from_slice(&32000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes
}
pub async fn audio(
    f: &Fixture,
    bytes: Vec<u8>,
    mime: &str,
    expected: Option<&str>,
) -> (u16, Value) {
    audio_for_call(f, bytes, mime, expected, None).await
}
pub async fn audio_for_call(
    f: &Fixture,
    bytes: Vec<u8>,
    mime: &str,
    expected: Option<&str>,
    call: Option<&str>,
) -> (u16, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(f.path("/speech/transcribe"))
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header("cookie", format!("openbot_account={}", f.owner_token))
        .header("content-type", mime);
    if let Some(expected) = expected {
        request = request.header("x-openbot-expected-user", expected);
    }
    if let Some(call) = call {
        request = request.header("x-openbot-voice-call", call);
    }
    let mut request = request.body(Body::from(bytes)).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41321".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(json!({"invalid":true})),
    )
}
pub fn configure(f: &Fixture, hold: bool) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let directory = f.directory.path().join("speech");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let binary = directory.join("synthetic-whisper");
    let marker = directory.join("started.json");
    let script = format!(
        r#"#!/usr/bin/python3
import json,os,pathlib,sys,time
args=sys.argv[1:]
output=pathlib.Path(args[args.index('-of')+1]+'.json')
audio=pathlib.Path(args[args.index('-f')+1])
pathlib.Path({marker:?}).write_text(json.dumps({{'pid':os.getpid(),'audio':str(audio),'cwd':os.getcwd(),'model':pathlib.Path(args[args.index('-m')+1]).name,'fast':'-ac' in args,'host_secret':os.environ.get('SYNTHETIC_HOST_SECRET')}}))
if {hold}:time.sleep(120)
output.write_text(json.dumps({{'transcription':[{{'text':'Synthetic local transcript'}}]}}))
"#,
        marker = marker.to_string_lossy(),
        hold = if hold { "True" } else { "False" }
    );
    std::fs::write(&binary, script).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let model = directory.join("synthetic-model.bin");
    std::fs::write(&model, b"synthetic local model").unwrap();
    let config = directory.join("config.json");
    std::fs::write(
        &config,
        json!({"version":1,"enabled":true,"binaryPath":binary,"modelPath":model,"threads":1})
            .to_string(),
    )
    .unwrap();
    std::fs::set_permissions(config, std::fs::Permissions::from_mode(0o600)).unwrap();
    marker
}
pub async fn started(marker: &std::path::Path) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(text) = std::fs::read(marker) {
                if let Ok(value) = serde_json::from_slice(&text) {
                    return value;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
