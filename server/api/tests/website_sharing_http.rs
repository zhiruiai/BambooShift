mod workspace_support;

use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use openbot_backend::config::OperationsConfig;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::{net::SocketAddr, sync::Arc};
use tower::ServiceExt;
use workspace_support::Fixture;

const OLD: &str = "<h1>Reviewed original</h1>";
const NEW: &str = "<h1>Reviewed update</h1>";
const OTHER: &str = "<h1>Unrelated private project</h1>";

async fn project_db(f: &Fixture) -> SqlitePool {
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    SqlitePool::connect(&format!(
        "sqlite:{}",
        store.directory.join("openbot.sqlite").display()
    ))
    .await
    .unwrap()
}

async fn version(db: &SqlitePool, id: &str, key: &str, body: &str) {
    let manifest = json!({
        "id":id,"projectKey":key,"title":"Reviewable website","entry":"index.html",
        "fileCount":1,"totalBytes":body.len(),"files":[
            {"path":"index.html","mime":"text/html","size":body.len(),
             "sha256":hex::encode(Sha256::digest(body.as_bytes()))}
        ]
    });
    sqlx::query("INSERT INTO website_projects(id,manifest) VALUES(?,?)")
        .bind(id)
        .bind(manifest.to_string())
        .execute(db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO website_project_files(project_id,path,bytes) VALUES(?,'index.html',?)",
    )
    .bind(id)
    .bind(body.as_bytes())
    .execute(db)
    .await
    .unwrap();
}

fn management(f: &Fixture, version: &str) -> String {
    f.path(&format!("/website-projects/{version}/share"))
}

fn public(settings: &Value) -> String {
    let token = settings["path"]
        .as_str()
        .unwrap()
        .strip_prefix("/pages/")
        .unwrap();
    assert_eq!(token.len(), 43);
    format!("/api/public/website-projects/{token}")
}

fn asset(path: &str, version: &str) -> String {
    format!("{path}/versions/{version}/files/index.html")
}

async fn put(f: &Fixture, version: &str, body: Value, member: bool) -> (u16, Value) {
    f.request(
        "PUT",
        &management(f, version),
        Some(body),
        member,
        Some(if member { &f.member } else { &f.owner }),
    )
    .await
}

async fn anonymous(f: &Fixture, path: &str) -> (u16, HeaderMap, Vec<u8>) {
    raw(f, path, false, false).await
}

async fn raw(
    f: &Fixture,
    path: &str,
    operations: bool,
    cross_site: bool,
) -> (u16, HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .uri(path)
        .header(
            "host",
            if operations {
                "127.0.0.1:3003"
            } else {
                "127.0.0.1:3002"
            },
        )
        .header("accept-language", "en");
    if cross_site {
        request = request
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .header("accept", "text/html");
    }
    let mut request = request.body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41321".parse::<SocketAddr>().unwrap(),
    ));
    let router = if operations {
        let mut state = f.state.clone();
        let mut config = state.config.as_ref().clone();
        config.operations = Some(OperationsConfig {
            bind: "127.0.0.1:3003".parse().unwrap(),
            public_origin: None,
            web_origin: None,
        });
        state.config = Arc::new(config);
        openbot_backend::operations_router(state)
    } else {
        openbot_backend::product_router(f.state.clone())
    };
    let response = router.oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let body = to_bytes(body, 1024 * 1024).await.unwrap().to_vec();
    (parts.status.as_u16(), parts.headers, body)
}

#[tokio::test]
async fn sharing_requires_an_explicit_version_and_revokes_old_tokens_and_assets() {
    let f = Fixture::new().await;
    let db = project_db(&f).await;
    let old = "a".repeat(64);
    let new = "b".repeat(64);
    let unrelated = "c".repeat(64);
    let key = "d".repeat(64);
    version(&db, &old, &key, OLD).await;
    version(&db, &unrelated, &"e".repeat(64), OTHER).await;

    let (status, initial) = f
        .request("GET", &management(&f, &old), None, false, Some(&f.owner))
        .await;
    assert_eq!(status, 200, "{initial}");
    assert_eq!(
        initial,
        json!({"visibility":"private","revision":null,"versionId":null,"viewerIds":[],"path":null})
    );
    assert_eq!(
        f.request("GET", &management(&f, &old), None, true, Some(&f.member))
            .await
            .0,
        403
    );
    assert_eq!(
        put(
            &f,
            &old,
            json!({"visibility":"public","expectedRevision":null}),
            true
        )
        .await
        .0,
        403
    );
    assert_eq!(
        f.request("GET", &management(&f, &old), None, false, None)
            .await
            .0,
        403
    );
    let (status, shared) = put(
        &f,
        &old,
        json!({"visibility":"public","expectedRevision":null}),
        false,
    )
    .await;
    assert_eq!(status, 200, "{shared}");
    let link = public(&shared);
    assert_eq!(shared["versionId"], old);

    let (status, headers, response) = anonymous(&f, &link).await;
    assert_eq!(status, 200);
    assert_eq!(headers["cache-control"], "private, no-store");
    assert_eq!(headers["referrer-policy"], "no-referrer");
    assert_eq!(headers["x-robots-tag"], "noindex, nofollow, noarchive");
    let manifest: Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(manifest["id"], old);
    assert_eq!(manifest.as_object().unwrap().len(), 7);
    assert!(!String::from_utf8_lossy(&response).contains(&f.workspace));
    assert!(!String::from_utf8_lossy(&response).contains(&f.owner));
    let (status, headers, bytes) = anonymous(&f, &asset(&link, &old)).await;
    assert_eq!(status, 200);
    assert_eq!(bytes, OLD.as_bytes());
    assert_eq!(headers["content-type"], "application/octet-stream");
    assert!(
        headers["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );
    assert!(
        headers["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("sandbox")
    );
    assert_eq!(anonymous(&f, &asset(&link, &unrelated)).await.0, 404);
    assert_eq!(anonymous(&f, &format!("{link}/download")).await.0, 404);
    assert_eq!(
        anonymous(
            &f,
            &format!("{link}/versions/{old}/files/assets/private.txt")
        )
        .await
        .0,
        404
    );
    assert_eq!(
        anonymous(&f, &f.path(&format!("/website-projects/{old}/download")))
            .await
            .0,
        401
    );
    assert_eq!(raw(&f, &link, true, false).await.0, 404);

    version(&db, &new, &key, NEW).await;
    assert_eq!(anonymous(&f, &asset(&link, &new)).await.0, 404);
    assert_eq!(anonymous(&f, &asset(&link, &old)).await.2, OLD.as_bytes());
    let (status, updated) = put(
        &f,
        &new,
        json!({"visibility":"public","expectedRevision":shared["revision"]}),
        false,
    )
    .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(public(&updated), link);
    assert_eq!(updated["versionId"], new);
    assert_eq!(anonymous(&f, &asset(&link, &old)).await.0, 404);
    assert_eq!(anonymous(&f, &asset(&link, &new)).await.2, NEW.as_bytes());
    let (status, conflict) = put(
        &f,
        &old,
        json!({"visibility":"private","expectedRevision":shared["revision"]}),
        false,
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(conflict["code"], "WEBSITE_SHARE_CHANGED");

    let (status, rotated) = put(
        &f,
        &new,
        json!({"visibility":"public","expectedRevision":updated["revision"],"rotate":true}),
        false,
    )
    .await;
    assert_eq!(status, 200, "{rotated}");
    let rotated_link = public(&rotated);
    assert_ne!(rotated_link, link);
    assert_eq!(anonymous(&f, &asset(&link, &new)).await.0, 404);
    assert_eq!(anonymous(&f, &asset(&rotated_link, &new)).await.0, 200);

    let (status, revoked) = put(
        &f,
        &new,
        json!({"visibility":"private","expectedRevision":rotated["revision"]}),
        false,
    )
    .await;
    assert_eq!(status, 200, "{revoked}");
    assert!(revoked["path"].is_null());
    assert!(revoked["versionId"].is_null());
    assert_eq!(anonymous(&f, &rotated_link).await.0, 404);
    assert_eq!(
        f.request(
            "GET",
            &f.path(&format!("/website-projects/{old}")),
            None,
            false,
            Some(&f.owner)
        )
        .await
        .0,
        200
    );
    db.close().await;
    f.close().await;
}

#[tokio::test]
async fn invited_viewers_need_current_membership_and_legacy_pages_cannot_be_claimed() {
    let f = Fixture::new().await;
    let db = project_db(&f).await;
    let id = "1".repeat(64);
    let key = "2".repeat(64);
    version(&db, &id, &key, OLD).await;
    let authored = "3".repeat(64);
    let authored_key = "4".repeat(64);
    version(&db, &authored, &authored_key, NEW).await;
    sqlx::query("INSERT INTO website_project_publishers(project_key,user_id) VALUES(?,?)")
        .bind(&authored_key)
        .bind(&f.member)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        put(
            &f,
            &authored,
            json!({"visibility":"team","expectedRevision":null}),
            true
        )
        .await
        .0,
        200
    );

    let (status, shared) = put(
        &f,
        &id,
        json!({"visibility":"invited","expectedRevision":null}),
        false,
    )
    .await;
    assert_eq!(status, 200, "{shared}");
    let link = public(&shared);
    let (status, _, body) = anonymous(&f, &link).await;
    assert_eq!(status, 401);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "WEBSITE_SHARE_SIGN_IN"
    );
    assert_eq!(f.request("GET", &link, None, false, None).await.0, 200);
    assert_eq!(f.request("GET", &link, None, true, None).await.0, 404);
    assert_eq!(put(&f,&id,json!({"visibility":"invited","expectedRevision":shared["revision"],"viewerIds":["unknown-user"]}),false).await.0,400);

    let (status, invited) = put(
        &f, &id, json!({"visibility":"invited","expectedRevision":shared["revision"],"viewerIds":[f.member]}), false,
    ).await;
    assert_eq!(status, 200, "{invited}");
    assert_eq!(public(&invited), link);
    assert_eq!(f.request("GET", &link, None, true, None).await.0, 200);
    let (status, team) = put(
        &f,
        &id,
        json!({"visibility":"team","expectedRevision":invited["revision"]}),
        false,
    )
    .await;
    assert_eq!(status, 200, "{team}");
    assert_eq!(public(&team), link);
    assert_eq!(f.request("GET", &link, None, true, None).await.0, 200);
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&f.workspace)
        .bind(&f.member)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(f.request("GET", &link, None, true, None).await.0, 404);
    assert_eq!(
        put(
            &f,
            &id,
            json!({"visibility":"public","expectedRevision":team["revision"]}),
            true
        )
        .await
        .0,
        403
    );

    sqlx::query("UPDATE workspaces SET status='suspended' WHERE id=?")
        .bind(&f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(anonymous(&f, &link).await.0, 404);
    db.close().await;
    f.close().await;
}

#[tokio::test]
async fn page_link_allows_top_level_cross_site_navigation_without_opening_operations() {
    let mut f = Fixture::new().await;
    let mut config = f.state.config.as_ref().clone();
    config.runtime_dir = f.directory.path().join("runtime");
    f.state.config = Arc::new(config);
    let dist = f.state.config.runtime_dir.join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(
        dist.join("index.html"),
        "<!doctype html><title>OpenBot</title>",
    )
    .unwrap();
    let page = format!("/pages/{}", "x".repeat(43));
    let (status, headers, _) = raw(&f, &page, false, true).await;
    assert_eq!(status, 200);
    assert_eq!(headers["x-frame-options"], "DENY");
    assert_eq!(headers["referrer-policy"], "no-referrer");
    assert_eq!(headers["x-robots-tag"], "noindex, nofollow, noarchive");
    assert_eq!(raw(&f, &page, true, false).await.0, 404);
    f.close().await;
}
