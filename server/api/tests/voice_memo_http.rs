#![cfg(unix)]
mod agent_delegation_support;
mod workspace_support;

use agent_delegation_support::Fixture;
#[cfg(target_os = "macos")]
use agent_delegation_support::{Model, call, finish};
#[cfg(target_os = "macos")]
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use serde_json::{Value, json};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
#[cfg(target_os = "macos")]
use tokio::sync::{Mutex, Semaphore};
#[cfg(target_os = "macos")]
use tower::ServiceExt;

fn input(content: &str, memo: bool) -> Value {
    let mut input =
        json!({"clientId":uuid::Uuid::new_v4().to_string(),"mode":"followUp","content":content});
    if memo {
        input["requestVoiceMemo"] = json!(true);
    }
    input
}

async fn send(f: &Fixture, cid: &str, input: Value) -> (u16, Value) {
    f.request(
        "POST",
        &f.path(&format!("/conversations/{cid}/messages")),
        Some(input),
        false,
        Some(&f.owner),
    )
    .await
}

async fn make_personal(f: &Fixture) {
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
}

#[tokio::test]
async fn voice_memo_rejects_unavailable_and_ineligible_intent_before_admission() {
    let f = Fixture::new().await;
    let before = f.bootstrap().await;
    let cid = before["conversations"][0]["id"].as_str().unwrap();
    assert_eq!(before["voiceMemo"]["available"], false);
    let body = input("Please reply in a voice memo.", true);
    let response = send(&f, cid, body.clone()).await;
    assert_eq!(response.0, 403);
    assert_eq!(response.1["code"], "VOICE_MEMO_SCOPE");
    let mut invalid = body.clone();
    invalid["mode"] = json!("steer");
    assert_eq!(send(&f, cid, invalid).await.1["code"], "VOICE_MEMO_INVALID");
    let mut invalid = body.clone();
    invalid["voiceCallId"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(send(&f, cid, invalid).await.1["code"], "VOICE_MEMO_INVALID");
    let mut invalid = body.clone();
    invalid["requestVoiceMemo"] = json!("true");
    assert_eq!(send(&f, cid, invalid).await.1["code"], "VOICE_MEMO_INVALID");

    make_personal(&f).await;
    assert_eq!(
        send(&f, cid, body).await.1["code"],
        "VOICE_MEMO_UNAVAILABLE"
    );
    assert_eq!(f.bootstrap().await["messages"], before["messages"]);
    f.close().await;
}

#[cfg(target_os = "macos")]
fn latest_tool(body: &Value) -> &str {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|entry| entry["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}

#[cfg(target_os = "macos")]
async fn download(f: &Fixture, id: &str, cookie: Option<&str>) -> (u16, String, Vec<u8>) {
    let mut request = Request::builder()
        .method("GET")
        .uri(f.path(&format!("/files/{id}/download")))
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002");
    if let Some(token) = cookie {
        request = request
            .header("cookie", format!("openbot_account={token}"))
            .header("x-openbot-expected-user", &f.owner);
    }
    let mut request = request.body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41321".parse::<SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let code = response.status().as_u16();
    let mime = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_owned();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (code, mime, bytes.to_vec())
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "Requires the installed offline Samantha and Tingting macOS voices"]
async fn authorized_pi_memo_queues_separately_and_delivers_immutable_audio_once() {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let f = Fixture::new().await;
    make_personal(&f).await;
    let speech = f.directory.path().join("speech");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&speech)
        .unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(speech.join("memo-synthesis.json"))
        .unwrap()
        .write_all(
            &serde_json::to_vec(&json!({"version":1,"enabled":true,
                "voices":{"zh-CN":"Tingting","en-US":"Samantha"}}))
            .unwrap(),
        )
        .unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let recorded = Arc::new(Mutex::new(Value::Null));
    let (model_entered, model_release, step, receipt) = (
        entered.clone(),
        release.clone(),
        requests.clone(),
        recorded.clone(),
    );
    let transcript = "This is a private synthetic memo. Its transcript matches the audio request.";
    let model = Model::new(Arc::new(move |body| {
        let (entered, release, step, receipt) = (
            model_entered.clone(),
            model_release.clone(),
            step.clone(),
            receipt.clone(),
        );
        Box::pin(async move {
            let offered = body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "send_voice_memo");
            match step.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    assert!(!offered);
                    entered.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    finish("First ordinary reply stays intact.")
                }
                1 => {
                    assert!(offered);
                    call(
                        "send_voice_memo",
                        json!({"transcript":"Hello [[slnc 5000]]","locale":"en-US"}),
                    )
                }
                2 => {
                    assert!(latest_tool(&body).contains("便笺"));
                    call(
                        "send_voice_memo",
                        json!({"transcript":transcript,"locale":"en-US"}),
                    )
                }
                3 => {
                    let result: Value = serde_json::from_str(latest_tool(&body)).unwrap();
                    assert_eq!(result["delivered"], true);
                    *receipt.lock().await = result;
                    call(
                        "send_voice_memo",
                        json!({"transcript":"This cannot create a second memo.","locale":"en-US"}),
                    )
                }
                4 => {
                    let result: Value = serde_json::from_str(latest_tool(&body)).unwrap();
                    assert_eq!(result, *receipt.lock().await);
                    let id = result["fileId"].as_str().unwrap();
                    call(
                        "workspace_write",
                        json!({"path":format!("{id}-voice-memo.wav"),"content":"altered"}),
                    )
                }
                5 => {
                    assert!(latest_tool(&body).contains("原始音频"));
                    finish("Voice memo attached.")
                }
                6 => {
                    assert!(!offered);
                    finish("Later ordinary reply stays separate.")
                }
                _ => panic!("Unexpected model request"),
            }
        })
    }))
    .await;
    let config = f
        .request(
            "PUT",
            &f.path("/settings"),
            Some(model.config()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(config.0, 200, "{}", config.1);
    let boot = f.bootstrap().await;
    assert_eq!(boot["voiceMemo"]["available"], true);
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    assert_eq!(
        send(&f, cid, input("Ordinary pending task.", false))
            .await
            .0,
        202
    );
    tokio::time::timeout(Duration::from_secs(20), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let body = input("Send the reply as a voice memo.", true);
    let accepted = send(&f, cid, body.clone()).await;
    assert_eq!(accepted.0, 202, "{}", accepted.1);
    assert_eq!(accepted.1["message"]["metadata"]["requestVoiceMemo"], true);
    let replay = send(&f, cid, body.clone()).await;
    assert_eq!(replay.1["message"]["id"], accepted.1["message"]["id"]);
    let mut changed = body.clone();
    changed.as_object_mut().unwrap().remove("requestVoiceMemo");
    assert_eq!(send(&f, cid, changed).await.0, 409);
    let mut last = input("A later ordinary task.", false);
    last["mode"] = json!("steer");
    assert_eq!(send(&f, cid, last).await.0, 202);
    release.add_permits(1);
    let snapshot = tokio::time::timeout(Duration::from_secs(65), async {
        loop {
            let snap = f.bootstrap().await;
            if snap["runningRequests"].as_array().unwrap().is_empty()
                && snap["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| message["content"] == "Later ordinary reply stays separate.")
            {
                break snap;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap();
    let messages = snapshot["messages"].as_array().unwrap();
    assert!(
        messages
            .iter()
            .any(|message| message["content"] == "First ordinary reply stays intact.")
    );
    let cards: Vec<_> = messages
        .iter()
        .filter(|message| message["metadata"]["voiceMemo"].is_object())
        .collect();
    assert_eq!(cards.len(), 1);
    let card = cards[0];
    assert_eq!(card["kind"], "file");
    assert_eq!(
        card["metadata"]["inputMessageId"],
        accepted.1["message"]["id"]
    );
    assert_eq!(card["metadata"]["voiceMemo"]["transcript"], transcript);
    let id = card["metadata"]["fileId"].as_str().unwrap();
    let (code, mime, bytes) = download(&f, id, Some(&f.owner_token)).await;
    assert_eq!(code, 200);
    assert_eq!(mime, "audio/wav");
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    assert_eq!(&bytes[24..28], &16000_u32.to_le_bytes());
    assert!(bytes[44..].iter().any(|byte| *byte != 0));
    assert_eq!(card["metadata"]["size"], bytes.len());
    assert_eq!(
        card["metadata"]["sha256"],
        hex::encode(Sha256::digest(&bytes))
    );
    assert_eq!(
        card["metadata"]["voiceMemo"]["durationMs"],
        (bytes.len() - 44) / 32
    );
    assert_ne!(download(&f, id, None).await.0, 200);
    assert_ne!(download(&f, id, Some(&f.member_token)).await.0, 200);
    assert_eq!(requests.load(Ordering::SeqCst), 7);
    assert_eq!(snapshot["files"].as_array().unwrap().len(), 1);

    let delete = f
        .request(
            "DELETE",
            &f.path(&format!("/files/{id}")),
            Some(json!({})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(delete.0, 200);
    assert_eq!(download(&f, id, Some(&f.owner_token)).await.0, 404);
    assert!(
        f.bootstrap().await["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["metadata"]["voiceMemo"]["transcript"] == transcript)
    );
    drop(model);
    f.close().await;
}
