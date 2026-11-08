mod workspace_media_support;
mod workspace_support;
use axum::body::Body;
use base64::{Engine, engine::general_purpose::STANDARD};
use openbot_backend::workspace::Table;
use serde_json::json;
use workspace_media_support::raw;
use workspace_support::Fixture;

#[tokio::test]
async fn upload_download_and_delete_preserve_bytes_actor_and_original_collision() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let cid = boot["conversations"][0]["id"].as_str().unwrap();
    let contents = [0, 1, 255, 23, 4];
    let body = json!({"name":"资料.txt","type":"application/octet-stream","content":STANDARD.encode(contents),"conversationId":cid});
    let (status, first) = f
        .request(
            "POST",
            &f.path("/files"),
            Some(body.clone()),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 201, "{first}");
    let (status, second) = f
        .request("POST", &f.path("/files"), Some(body), true, Some(&f.member))
        .await;
    assert_eq!(status, 201, "{second}");
    assert_ne!(first["name"], second["name"]);
    let path = f.path(&format!(
        "/files/{}/download",
        first["id"].as_str().unwrap()
    ));
    let (status, headers, bytes) = raw(
        &f,
        "GET",
        &path,
        "application/json",
        Body::empty(),
        true,
        Some(&f.member),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(bytes, contents);
    assert!(
        headers["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    assert!(
        headers["content-disposition"]
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''%E8%B5%84%E6%96%99.txt")
    );
    let messages = f.bootstrap().await["messages"].clone();
    let file_messages: Vec<_> = messages
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["kind"] == "file")
        .collect();
    assert_eq!(file_messages.len(), 2);
    assert!(
        file_messages
            .iter()
            .all(|m| m["userId"] == f.member && m["metadata"]["author"]["id"] == f.member)
    );
    let (status, _) = f
        .request(
            "DELETE",
            &f.path(&format!("/files/{}", first["id"].as_str().unwrap())),
            None,
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        raw(
            &f,
            "GET",
            &path,
            "application/json",
            Body::empty(),
            true,
            Some(&f.member)
        )
        .await
        .0,
        404
    );
    let next = f.path(&format!(
        "/files/{}/download",
        second["id"].as_str().unwrap()
    ));
    assert_eq!(
        raw(
            &f,
            "GET",
            &next,
            "application/json",
            Body::empty(),
            true,
            Some(&f.member)
        )
        .await
        .2,
        contents
    );
    f.close().await;
}
#[tokio::test]
async fn file_mutations_require_fixed_actor_and_do_not_create_on_invalid_chat_or_name() {
    let f = Fixture::new().await;
    f.bootstrap().await;
    let base = json!({"name":"safe.txt","content":STANDARD.encode("data")});
    for expected in [None, Some(f.owner.as_str())] {
        assert_eq!(
            f.request(
                "POST",
                &f.path("/files"),
                Some(base.clone()),
                true,
                expected
            )
            .await
            .0,
            403
        );
    }
    for change in [
        json!({"name":"../outside"}),
        json!({"name":"a/b"}),
        json!({"name":"a\\b"}),
        json!({"name":".openbot-delete-private"}),
        json!({"content":"not base64!"}),
        json!({"conversationId":"missing"}),
        json!({"type":"text/html\r\nInjected: true"}),
    ] {
        let mut input = base.clone();
        input
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        let (status, response) = f
            .request(
                "POST",
                &f.path("/files"),
                Some(input),
                false,
                Some(&f.owner),
            )
            .await;
        assert!(matches!(status, 400 | 404), "{status}: {response}");
    }
    assert!(f.bootstrap().await["files"].as_array().unwrap().is_empty());
    assert!(
        f.bootstrap().await["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    f.close().await;
}
#[tokio::test]
async fn download_rejects_symlinks_hardlinks_special_files_and_cross_workspace() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new().await;
    f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let directory = store.directory.join("workspace");
    std::fs::create_dir(&directory).unwrap();
    let outside = f.directory.path().join("canary.txt");
    std::fs::write(&outside, b"private-canary").unwrap();
    symlink(&outside, directory.join("link")).unwrap();
    std::fs::hard_link(&outside, directory.join("hard")).unwrap();
    symlink(f.directory.path(), directory.join("parent")).unwrap();
    let fifo = std::ffi::CString::new(directory.join("fifo").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    for name in ["link", "hard", "parent/canary.txt", "fifo", "../canary.txt"] {
        let id = uuid::Uuid::new_v4().to_string();
        store
            .put(
                Table::Files,
                &json!({"id":id,"name":name,"size":14,"type":"text/plain"}),
            )
            .await
            .unwrap();
        let path = f.path(&format!("/files/{id}/download"));
        assert_eq!(
            raw(
                &f,
                "GET",
                &path,
                "application/json",
                Body::empty(),
                false,
                Some(&f.owner)
            )
            .await
            .0,
            409,
            "{name}"
        );
        assert_eq!(
            f.request(
                "DELETE",
                &f.path(&format!("/files/{id}")),
                None,
                false,
                Some(&f.owner)
            )
            .await
            .0,
            409,
            "{name}"
        );
        let foreign = format!("/api/workspaces/{}/files/{id}/download", f.foreign);
        assert_eq!(
            raw(
                &f,
                "GET",
                &foreign,
                "application/json",
                Body::empty(),
                false,
                Some(&f.owner)
            )
            .await
            .0,
            403
        );
    }
    assert_eq!(std::fs::read(outside).unwrap(), b"private-canary");
    f.close().await;
}
#[tokio::test]
async fn upload_over_default_json_limit_and_bounded_maximum() {
    let f = Fixture::new().await;
    let content = vec![7u8; 80 * 1024];
    let body = json!({"name":"large.bin","content":STANDARD.encode(&content)});
    let (status, file) = f
        .request("POST", &f.path("/files"), Some(body), false, Some(&f.owner))
        .await;
    assert_eq!(status, 201, "{file}");
    let path = f.path(&format!("/files/{}/download", file["id"].as_str().unwrap()));
    assert_eq!(
        raw(
            &f,
            "GET",
            &path,
            "application/json",
            Body::empty(),
            false,
            Some(&f.owner)
        )
        .await
        .2,
        content
    );
    let (status, _) = f
        .request(
            "POST",
            &f.path("/files"),
            Some(json!({"name":"too-large","content":STANDARD.encode(vec![1;10*1024*1024+1])})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 413);
    assert_eq!(f.bootstrap().await["files"].as_array().unwrap().len(), 1);
    f.close().await;
}

#[tokio::test]
async fn failed_database_commit_cleans_new_file_and_restores_staged_deletion() {
    let f = Fixture::new().await;
    let boot = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER reject_file_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&store.pool).await.unwrap();
    let body = json!({"name":"rollback.txt","content":STANDARD.encode("unaltered"),"conversationId":boot["conversations"][0]["id"]});
    let (status, _) = f
        .request(
            "POST",
            &f.path("/files"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 500);
    assert!(!store.directory.join("workspace/rollback.txt").exists());
    assert!(store.list(Table::Files).await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER reject_file_message")
        .execute(&store.pool)
        .await
        .unwrap();
    let (status, file) = f
        .request("POST", &f.path("/files"), Some(body), false, Some(&f.owner))
        .await;
    assert_eq!(status, 201, "{file}");
    sqlx::query("CREATE TRIGGER reject_file_delete BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&store.pool).await.unwrap();
    let path = f.path(&format!("/files/{}", file["id"].as_str().unwrap()));
    assert_eq!(
        f.request("DELETE", &path, None, false, Some(&f.owner))
            .await
            .0,
        500
    );
    assert_eq!(
        std::fs::read(store.directory.join("workspace/rollback.txt")).unwrap(),
        b"unaltered"
    );
    assert_eq!(
        std::fs::read_dir(store.directory.join("workspace"))
            .unwrap()
            .count(),
        1
    );
    sqlx::query("DROP TRIGGER reject_file_delete")
        .execute(&store.pool)
        .await
        .unwrap();
    std::fs::remove_file(store.directory.join("workspace/rollback.txt")).unwrap();
    assert_eq!(
        f.request("DELETE", &path, None, false, Some(&f.owner))
            .await
            .0,
        200
    );
    assert!(store.list(Table::Files).await.unwrap().is_empty());
    f.close().await;
}

#[tokio::test]
async fn generated_files_larger_than_upload_cap_stream_and_remain_deletable() {
    let f = Fixture::new().await;
    f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    std::fs::create_dir(store.directory.join("workspace")).unwrap();
    let bytes = vec![23; 11 * 1024 * 1024];
    std::fs::write(store.directory.join("workspace/generated.bin"), &bytes).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store.put(Table::Files,&json!({"id":id,"name":"generated.bin","size":bytes.len(),"type":"application/octet-stream"})).await.unwrap();
    let path = f.path(&format!("/files/{id}/download"));
    let (status, headers, download) =
        raw(&f, "GET", &path, "", Body::empty(), false, Some(&f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(headers["content-length"], bytes.len().to_string());
    assert_eq!(download, bytes);
    assert_eq!(
        f.request(
            "DELETE",
            &f.path(&format!("/files/{id}")),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    assert!(!store.directory.join("workspace/generated.bin").exists());
    f.close().await;
}

#[tokio::test]
async fn active_download_rechecks_original_session_before_later_chunks() {
    use axum::{extract::ConnectInfo, http::Request};
    use futures_util::StreamExt;
    use tower::ServiceExt;
    let f = Fixture::new().await;
    let (status, file) = f
        .request(
            "POST",
            &f.path("/files"),
            Some(json!({"name":"stream.bin","content":STANDARD.encode(vec![55;256*1024])})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 201);
    let path = f.path(&format!("/files/{}/download", file["id"].as_str().unwrap()));
    let mut request = Request::builder()
        .uri(&path)
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header("cookie", format!("openbot_account={}", f.owner_token))
        .header("x-openbot-expected-user", &f.owner)
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41323".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut stream = response.into_body().into_data_stream();
    let first = stream.next().await.unwrap().unwrap();
    assert_eq!(first.len(), 64 * 1024);
    sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
        .bind(&f.owner)
        .execute(&f.db)
        .await
        .unwrap();
    assert!(stream.next().await.unwrap().is_err());
    drop(stream);
    f.close().await;
}
