use super::*;

#[test]
fn only_a_matching_attachment_receipt_confirms_dispatch() {
    let payload = json!({"url":"https://creator.example","sha256":"a".repeat(64)});
    let valid = json!({"attached":true,"origin":payload["url"],"sha256":payload["sha256"]});
    let reply = |value: &Value| {
        Ok(super::super::transport::Reply {
            status: 200,
            headers: Default::default(),
            bytes: value.to_string().into_bytes(),
        })
    };
    assert_eq!(attachment_result(reply(&valid), &payload).unwrap(), valid);
    for key in ["attached", "origin", "sha256"] {
        let mut invalid = valid.clone();
        invalid[key] = Value::Null;
        assert_eq!(
            attachment_result(reply(&invalid), &payload)
                .unwrap_err()
                .status,
            502
        );
    }
    let offline = ApiError::new(502, "连接中断");
    assert!(
        attachment_result(Err(offline), &payload)
            .unwrap_err()
            .message
            .contains("可能已经")
    );
    let denied = ApiError::new(403, "已拒绝");
    assert_eq!(
        attachment_result(Err(denied), &payload).unwrap_err().status,
        403
    );
}

#[test]
fn completed_upload_is_bound_to_the_requester_chat_bot_and_target_revision() {
    let revision = json!(uuid::Uuid::new_v4().to_string());
    let context = ActionContext {
        conversation_id: Some("chat".into()),
        agent_id: Some("bot".into()),
        requester: Some(json!({"userId":"owner"})),
        ..Default::default()
    };
    let payload = json!({"fileId":"image-1","path":"images/cover.png","sha256":"a".repeat(64)});
    let record = json!({"context":context,"action":{
        "requester":{"userId":"owner"},"execution":{"targetRevision":revision},
        "type":"upload_file","status":"done","payload":payload,"result":{"path":payload["path"],"sha256":payload["sha256"]}
    }});
    assert_eq!(
        uploaded_file(&record, &context, &revision).unwrap(),
        &payload
    );
    let new_revision = json!(uuid::Uuid::new_v4().to_string());
    assert!(uploaded_file(&record, &context, &new_revision).is_err());
    for (path, value) in [
        ("/action/status", "error"),
        ("/action/status", "pending"),
        ("/action/type", "download_file"),
        ("/action/result/path", "other.png"),
        ("/action/result/sha256", "wrong"),
        ("/context/conversationId", "elsewhere"),
        ("/context/agentId", "another-bot"),
        ("/action/requester/userId", "another-user"),
    ] {
        let mut different = record.clone();
        *different.pointer_mut(path).unwrap() = json!(value);
        assert!(
            uploaded_file(&different, &context, &revision).is_err(),
            "{path}"
        );
    }
}
