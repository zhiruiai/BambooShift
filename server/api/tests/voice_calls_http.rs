#![cfg(unix)]
mod agent_queue_support;
mod speech_support;
mod workspace_support;

use agent_queue_support::{Fixture, Model, wait};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use uuid::Uuid;

fn request_id() -> String {
    Uuid::new_v4().to_string()
}

#[tokio::test]
async fn call_audio_uses_fast_local_model_and_hangup_cancels_recognition() {
    let f = std::sync::Arc::new(Fixture::new().await);
    let marker = speech_support::configure(&f, true);
    let config_path = f.directory.path().join("speech/config.json");
    let model = f.directory.path().join("speech/synthetic-voice.bin");
    std::fs::write(&model, b"synthetic fast model").unwrap();
    let mut config: Value = serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
    config["voiceModelPath"] = json!(model);
    std::fs::write(config_path, config.to_string()).unwrap();
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    let calls = format!("/conversations/{cid}/voice-calls");
    let id = request_id();
    assert_eq!(
        speech_support::audio_for_call(
            &f,
            speech_support::wav(),
            "audio/wav",
            Some(&f.owner),
            Some(&id)
        )
        .await
        .1["code"],
        "VOICE_CALL_NOT_FOUND"
    );
    assert!(!marker.exists());
    assert_eq!(
        request(&f, "POST", &calls, Some(json!({"id":id})), false)
            .await
            .0,
        200
    );
    let process = {
        let f = f.clone();
        let id = id.clone();
        tokio::spawn(async move {
            speech_support::audio_for_call(
                &f,
                speech_support::wav(),
                "audio/wav",
                Some(&f.owner),
                Some(&id),
            )
            .await
        })
    };
    let state = speech_support::started(&marker).await;
    assert_eq!(state["fast"], true);
    assert_eq!(state["model"], "synthetic-voice.bin");
    assert_eq!(
        request(
            &f,
            "POST",
            &format!("{calls}/{id}/end"),
            Some(json!({})),
            false
        )
        .await
        .0,
        200
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), process)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.1["code"], "VOICE_CALL_ENDED");
    assert!(!std::path::Path::new(state["cwd"].as_str().unwrap()).exists());
    let f = std::sync::Arc::try_unwrap(f).ok().unwrap();
    f.close().await;
}

async fn request(
    f: &Fixture,
    method: &str,
    route: &str,
    body: Option<Value>,
    member: bool,
) -> (u16, Value) {
    let actor = if member { &f.member } else { &f.owner };
    f.request(method, &f.path(route), body, member, Some(actor))
        .await
}

#[tokio::test]
async fn voice_call_lifecycle_is_actor_scoped_and_replacement_is_explicit() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    let calls = format!("/conversations/{cid}/voice-calls");
    let first = request_id();
    let second = request_id();
    assert_eq!(
        request(&f, "POST", &calls, Some(json!({"id":first})), false)
            .await
            .1["code"],
        "SPEECH_UNAVAILABLE"
    );
    speech_support::configure(&f, false);
    assert_eq!(
        request(&f, "POST", &calls, Some(json!({"id":"bad-id"})), false)
            .await
            .1["code"],
        "VOICE_CALL_INVALID"
    );
    let (status, open) = request(&f, "POST", &calls, Some(json!({"id":first})), false).await;
    assert_eq!(status, 200, "{open}");
    assert_eq!(open["call"]["userId"], f.owner);
    assert_eq!(open["call"]["conversationId"], cid);
    assert_eq!(
        request(&f, "POST", &calls, Some(json!({"id":first})), false)
            .await
            .1,
        open
    );
    assert_eq!(request(&f, "GET", &calls, None, false).await.1, open);
    assert_eq!(
        request(&f, "GET", &calls, None, true).await.1["call"],
        Value::Null
    );
    assert_eq!(
        request(&f, "GET", &format!("{calls}/{first}"), None, true)
            .await
            .0,
        404
    );
    assert_eq!(
        request(
            &f,
            "POST",
            &format!("{calls}/{first}/end"),
            Some(json!({})),
            true
        )
        .await
        .0,
        404
    );
    assert_eq!(
        request(&f, "POST", &calls, Some(json!({"id":second})), false)
            .await
            .1["code"],
        "VOICE_CALL_ACTIVE"
    );
    let (status, next) = request(
        &f,
        "POST",
        &calls,
        Some(json!({"id":second,"replaceId":first})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{next}");
    assert_eq!(next["call"]["id"], second);
    let ended = request(&f, "GET", &format!("{calls}/{first}"), None, false)
        .await
        .1;
    assert!(ended["call"]["endedAt"].is_string());
    assert_eq!(
        request(
            &f,
            "POST",
            &format!("{calls}/{first}/end"),
            Some(json!({})),
            false
        )
        .await
        .1,
        ended
    );

    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let group = request_id();
    let mut group_data = boot["conversations"][0].clone();
    group_data["id"] = json!(group);
    group_data["isGroup"] = json!(true);
    store.put(Table::Conversations, &group_data).await.unwrap();
    assert_eq!(
        request(
            &f,
            "POST",
            &format!("/conversations/{group}/voice-calls"),
            Some(json!({"id":request_id(),"replaceId":second})),
            false
        )
        .await
        .1["code"],
        "VOICE_CALL_UNAVAILABLE"
    );
    assert_eq!(
        request(&f, "GET", &calls, None, false).await.1["call"]["id"],
        second
    );
    assert!(
        !f.bootstrap().await["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["kind"] == "voice_call")
    );
    f.close().await;
}

#[tokio::test]
async fn voice_turns_have_exact_pi_receipts_and_hangup_leaves_accepted_work_running() {
    let f = Fixture::new().await;
    speech_support::configure(&f, false);
    let model = Model::new(&f).await;
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    let base = format!("/conversations/{cid}");
    let call = request_id();
    let calls = format!("{base}/voice-calls");
    let messages = format!("{base}/messages");
    let hangup = format!("{calls}/{call}/end");
    assert_eq!(
        request(&f, "POST", &calls, Some(json!({"id":call})), false)
            .await
            .0,
        200
    );
    let spoken = json!({"content":"My first voice turn", "clientId":request_id(), "voiceCallId":call, "mode":"followUp"});
    let (status, receipt) = request(&f, "POST", &messages, Some(spoken.clone()), false).await;
    assert_eq!(status, 202, "{receipt}");
    assert_eq!(receipt["message"]["metadata"]["voiceCallId"], call);
    let input = receipt["message"]["id"].as_str().unwrap();
    model.wait().await;
    let second = json!({"content":"My second voice turn", "clientId":request_id(), "voiceCallId":call, "mode":"followUp"});
    assert_eq!(
        request(&f, "POST", &messages, Some(second.clone()), false)
            .await
            .1["code"],
        "VOICE_CALL_BUSY"
    );
    assert_eq!(
        request(&f, "POST", &messages, Some(second.clone()), true)
            .await
            .1["code"],
        "VOICE_CALL_NOT_FOUND"
    );
    let normal = agent_queue_support::submit(&f, cid, "Separate typed task", "steer", false).await;
    let (_, ended) = request(&f, "POST", &hangup, Some(json!({})), false).await;
    assert!(ended["call"]["endedAt"].is_string());
    assert_eq!(
        request(&f, "POST", &hangup, Some(json!({})), false).await.1,
        ended
    );
    assert_eq!(
        request(&f, "POST", &messages, Some(second), false).await.1["code"],
        "VOICE_CALL_ENDED"
    );
    let replay = request(&f, "POST", &messages, Some(spoken.clone()), false).await;
    assert_eq!(replay.0, 202);
    assert_eq!(replay.1["message"]["id"], input);
    let mut different = spoken;
    different.as_object_mut().unwrap().remove("voiceCallId");
    assert_eq!(
        request(&f, "POST", &messages, Some(different), false)
            .await
            .0,
        409
    );

    model.release.add_permits(1);
    let done =
        wait(&f, |snapshot| {
            snapshot["runningRequests"].as_array().unwrap().is_empty()
                && snapshot["messages"].as_array().unwrap().iter().any(|m| {
                    m["metadata"]["inputMessageId"] == normal["id"] && m["status"] == "done"
                })
        })
        .await;
    let rows = done["messages"].as_array().unwrap();
    let terminal = rows
        .iter()
        .filter(|m| m["metadata"]["voiceCallTerminal"] == true)
        .collect::<Vec<_>>();
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0]["metadata"]["inputMessageId"], input);
    assert_eq!(terminal[0]["metadata"]["voiceCallId"], call);
    assert_eq!(
        terminal[0]["metadata"]["runId"],
        receipt["message"]["delivery"]["runId"]
    );
    assert_eq!(terminal[0]["status"], "done");
    let cards = rows
        .iter()
        .filter(|m| m["kind"] == "voice_call")
        .collect::<Vec<_>>();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["userId"], f.owner);
    assert_eq!(cards[0]["metadata"]["voiceCall"]["id"], call);
    assert!(
        cards[0]["metadata"]["voiceCall"]["durationMs"]
            .as_u64()
            .is_some()
    );
    assert_eq!(model.calls.lock().await.len(), 2);
    f.close().await;
}
