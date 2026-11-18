use super::*;
use crate::{config::Config, test_process::ProcessProbe};
use std::sync::atomic::{AtomicBool, Ordering};

async fn fixture(script: &str) -> (tempfile::TempDir, State) {
    let directory = tempfile::tempdir().unwrap();
    let runtime = directory.path().join("runtime");
    std::fs::create_dir_all(runtime.join("server/workers/document-worker")).unwrap();
    std::fs::write(
        runtime.join("server/workers/document-worker/index.ts"),
        script,
    )
    .unwrap();
    let mut config = Config::local(directory.path().join("data"));
    config.runtime_dir = runtime;
    if let Some(node) = std::env::var_os("OPENBOT_NODE") {
        config.node_binary = node.into();
    }
    let state = State::open(config).await.unwrap();
    (directory, state)
}
fn allowed() -> Authority {
    Arc::new(|| Box::pin(async { Ok(()) }))
}
async fn running_process(path: &std::path::Path) -> ProcessProbe {
    let pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(value) = tokio::fs::read_to_string(path).await {
                if let Ok(pid) = value.parse::<u32>() {
                    break pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The parser did not announce its PID");
    ProcessProbe::attach(pid).expect("The parser must be alive before testing termination")
}
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn deadline_and_oversized_output_both_reap_the_actual_parser() {
    let _serial = SERIAL.lock().await;
    let script = r#"
import {writeFileSync,existsSync} from 'node:fs';
writeFileSync('pid.txt',String(process.pid));
while(!existsSync('release.txt'))await new Promise(resolve=>setTimeout(resolve,10));
process.stdout.write('x'.repeat(13*1024*1024));
setInterval(()=>{},1000);
"#;
    let (d, state) = fixture(script).await;
    let task = tokio::spawn({
        let state = state.clone();
        async move { parse(&state, "large.txt".into(), b"fixture".to_vec(), allowed()).await }
    });
    // Attach before the parser can overflow: Windows retains the actual process handle.
    let process = running_process(&d.path().join("runtime/pid.txt")).await;
    tokio::fs::write(d.path().join("runtime/release.txt"), b"release")
        .await
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().status.as_u16(), 422);
    process.wait_for_exit(Duration::from_secs(5)).await.unwrap();
    state.close().await;
    let script = "import {writeFileSync} from 'node:fs';writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000);";
    let (d, state) = fixture(script).await;
    let began = std::time::Instant::now();
    let task = tokio::spawn({
        let state = state.clone();
        async move { parse(&state, "timeout.txt".into(), b"fixture".to_vec(), allowed()).await }
    });
    let process = running_process(&d.path().join("runtime/pid.txt")).await;
    let error = task.await.unwrap().unwrap_err();
    assert!(error.message.contains("超时"));
    assert!(began.elapsed() >= Duration::from_secs(19));
    assert!(began.elapsed() < Duration::from_secs(26));
    process.wait_for_exit(Duration::from_secs(5)).await.unwrap();
    assert_eq!(SLOTS.get().unwrap().available_permits(), 2);
    state.close().await;
}

#[tokio::test]
async fn dropped_caller_and_revoked_authority_reap_before_releasing_the_two_slots() {
    let _serial = SERIAL.lock().await;
    let script = "import {writeFileSync} from 'node:fs';writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000);";
    let (d, state) = fixture(script).await;
    let (d2, state2) = fixture(script).await;
    let task = tokio::spawn({
        let state = state.clone();
        async move { parse(&state, "text.txt".into(), b"one".to_vec(), allowed()).await }
    });
    let first = running_process(&d.path().join("runtime/pid.txt")).await;
    let valid = Arc::new(AtomicBool::new(true));
    let auth: Authority = Arc::new({
        let valid = valid.clone();
        move || {
            let valid = valid.clone();
            Box::pin(async move {
                if valid.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(ApiError::new(403, "Synthetic access revoked"))
                }
            })
        }
    });
    let second = tokio::spawn({
        let state = state2.clone();
        async move { parse(&state, "text.txt".into(), b"two".to_vec(), auth).await }
    });
    let second_process = running_process(&d2.path().join("runtime/pid.txt")).await;
    assert_eq!(
        parse(&state, "text.txt".into(), b"three".to_vec(), allowed())
            .await
            .unwrap_err()
            .status
            .as_u16(),
        429
    );
    task.abort();
    let _ = task.await;
    first.wait_for_exit(Duration::from_secs(5)).await.unwrap();
    valid.store(false, Ordering::Release);
    assert_eq!(second.await.unwrap().unwrap_err().status.as_u16(), 403);
    second_process
        .wait_for_exit(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(SLOTS.get().unwrap().available_permits(), 2);
    state.close().await;
    state2.close().await;
}

#[tokio::test]
async fn worker_receives_no_parent_environment_or_host_path_request() {
    let _serial = SERIAL.lock().await;
    let script = r#"
let text='';for await(const chunk of process.stdin)text+=chunk;
const input=JSON.parse(text);
const envKeys=Object.keys(process.env).sort().join(',');
if(Object.keys(input).sort().join(',')!=='data,name,version')process.exit(4);
console.log(JSON.stringify({version:1,ok:true,result:{kind:'text',name:input.name,byteLength:Buffer.from(input.data,'base64').length,mimeType:'text/plain',sourceMimeType:'text/plain',text:envKeys,warnings:[],truncated:false}}));
"#;
    let (_d, state) = fixture(script).await;
    let value = parse(
        &state,
        "synthetic.txt".into(),
        b"approved".to_vec(),
        allowed(),
    )
    .await
    .unwrap();
    // macOS initializes this locale value inside the child; it is not inherited credentials.
    assert_eq!(
        value["text"],
        if cfg!(target_os = "macos") {
            "LANG,__CF_USER_TEXT_ENCODING"
        } else {
            "LANG"
        }
    );
    state.close().await;
}
