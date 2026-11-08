mod agent_delegation_support;
mod workspace_support;

use agent_delegation_support::{Fixture, Group, Model, call, finish, has_tool_result};
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;

const TOOL: &str = "workspace_deliver_website";
const ENTRY: &str = "<!doctype html><link rel=stylesheet href=assets/site.css><h1>Synthetic site</h1><script src=assets/main.js></script>";
const CSS: &str = "h1 { color: rebeccapurple }";
const JS: &str = "document.querySelector('h1').dataset.ready = 'true';";
const UPDATED: &str = "<!doctype html><h1>Updated synthetic site</h1>";

fn hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn logo() -> Vec<u8> {
    STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0tcAAAAASUVORK5CYII=").unwrap()
}

fn logo_hash() -> String {
    hex::encode(Sha256::digest(logo()))
}

fn request(entry: &str) -> Value {
    json!({"directory":"synthetic-site","title":"Synthetic website","entry":"index.html","files":[
        {"path":"index.html","sha256":hash(entry)},
        {"path":"assets/site.css","sha256":hash(CSS)},
        {"path":"assets/main.js","sha256":hash(JS)},
        {"path":"assets/logo.png","sha256":logo_hash()}
    ]})
}

fn writes(path: &str, content: &str) -> axum::http::Response<Body> {
    call(
        "workspace_write",
        json!({"path":format!("synthetic-site/{path}"),"content":content}),
    )
}

fn tool_result(body: &Value) -> Value {
    let result = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap();
    serde_json::from_str(result["content"].as_str().unwrap()).unwrap()
}

fn cards(messages: &[Value]) -> Vec<&Value> {
    messages
        .iter()
        .filter(|m| m["kind"] == "website_project")
        .collect()
}

async fn get(fixture: &Fixture, path: &str, expected: Option<&str>) -> (u16, HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .uri(path)
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header("cookie", format!("openbot_account={}", fixture.owner_token));
    if let Some(expected) = expected {
        request = request.header("x-openbot-expected-user", expected);
    }
    let mut request = request.body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41321".parse::<SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(fixture.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 11 * 1024 * 1024).await.unwrap();
    (parts.status.as_u16(), parts.headers, bytes.to_vec())
}

fn read_zip(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let u16_at =
        |index: usize| u16::from_le_bytes(bytes[index..index + 2].try_into().unwrap()) as usize;
    let u32_at =
        |index: usize| u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap()) as usize;
    let end = bytes.len() - 22;
    assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
    let mut central = u32_at(end + 16);
    assert_eq!(central + u32_at(end + 12), end);
    let mut files = BTreeMap::new();
    for _ in 0..u16_at(end + 10) {
        assert_eq!(&bytes[central..central + 4], b"PK\x01\x02");
        let name_length = u16_at(central + 28);
        let name = std::str::from_utf8(&bytes[central + 46..central + 46 + name_length]).unwrap();
        let local = u32_at(central + 42);
        assert_eq!(&bytes[local..local + 4], b"PK\x03\x04");
        assert_eq!(u16_at(local + 8), 0);
        assert_eq!(u32_at(local + 14), u32_at(central + 16));
        assert_eq!(u16_at(local + 26), name_length);
        assert_eq!(
            &bytes[local + 30..local + 30 + name_length],
            name.as_bytes()
        );
        let content = local + 30 + name_length + u16_at(local + 28);
        assert!(
            files
                .insert(
                    name.to_owned(),
                    bytes[content..content + u32_at(central + 24)].to_vec()
                )
                .is_none()
        );
        central += 46 + name_length + u16_at(central + 30) + u16_at(central + 32);
    }
    assert_eq!(central, end);
    files
}

#[tokio::test]
async fn website_cards_publish_exact_bytes_and_keep_earlier_versions() {
    let group = Group::new().await;
    let assets = group
        .store
        .directory
        .join("workspace/synthetic-site/assets");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("logo.png"), logo()).unwrap();
    group.store.put(Table::Files, &json!({"id":"fixture-logo","name":"synthetic-site/assets/logo.png","type":"image/png"})).await.unwrap();
    let step = Arc::new(AtomicUsize::new(0));
    let calls = step.clone();
    let model = Model::new(Arc::new(move |body| {
        let calls = calls.clone();
        Box::pin(async move {
            assert!(
                body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == TOOL)
            );
            match calls.fetch_add(1, Ordering::SeqCst) {
                0 => writes("index.html", ENTRY),
                1 => writes("assets/site.css", CSS),
                2 => writes("assets/main.js", JS),
                3 => call("workspace_read", json!({"path":"synthetic-site/assets/logo.png","digestOnly":true})),
                4 => {
                    assert_eq!(tool_result(&body), json!({"path":"synthetic-site/assets/logo.png","size":logo().len(),"sha256":logo_hash()}));
                    call(TOOL, request(ENTRY))
                }
                5 => {
                    assert_eq!(tool_result(&body)["delivered"], true);
                    let mut retry = request(ENTRY);
                    retry["files"].as_array_mut().unwrap().reverse();
                    retry["files"][1]["sha256"] = json!(hash(JS).to_ascii_uppercase());
                    call(TOOL, retry)
                }
                6 => {
                    assert_eq!(tool_result(&body)["delivered"], true);
                    writes("index.html", UPDATED)
                }
                7 => finish("The private website version is ready."),
                _ => panic!("Unexpected synthetic call"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Build and deliver a synthetic four-file website.",
            "followUp",
            true,
        )
        .await;
    let first = group.done().await;
    let first = cards(&first);
    assert_eq!(first.len(), 1);
    assert_eq!(step.load(Ordering::SeqCst), 8);
    let summary = &first[0]["metadata"]["websiteProject"];
    assert_eq!(summary["fileCount"], 4);
    assert_eq!(summary["entry"], "index.html");
    assert_eq!(
        summary["totalBytes"],
        ENTRY.len() + CSS.len() + JS.len() + logo().len()
    );
    let old_id = summary["id"].as_str().unwrap().to_owned();
    let key = summary["projectKey"].as_str().unwrap().to_owned();
    let root = group.f.path(&format!("/website-projects/{old_id}"));
    let (status, headers, bytes) = get(&group.f, &root, Some(&group.f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
    let manifest: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest["projectKey"], key);
    assert_eq!(
        manifest["files"],
        json!([
            {"path":"assets/logo.png","mime":"image/png","size":logo().len(),"sha256":logo_hash()},
            {"path":"assets/main.js","mime":"text/javascript","size":JS.len(),"sha256":hash(JS)},
            {"path":"assets/site.css","mime":"text/css","size":CSS.len(),"sha256":hash(CSS)},
            {"path":"index.html","mime":"text/html","size":ENTRY.len(),"sha256":hash(ENTRY)}
        ])
    );
    let (status, headers, bytes) = get(
        &group.f,
        &format!("{root}/files/assets/main.js"),
        Some(&group.f.owner),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"main.js\""
    );
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(bytes, JS.as_bytes());
    let zip = format!("{root}/download");
    let (status, headers, bytes) = get(&group.f, &zip, Some(&group.f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(headers[header::CONTENT_TYPE], "application/zip");
    assert!(
        headers[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert_eq!(
        read_zip(&bytes),
        BTreeMap::from([
            ("index.html".into(), ENTRY.as_bytes().to_vec()),
            ("assets/site.css".into(), CSS.as_bytes().to_vec()),
            ("assets/main.js".into(), JS.as_bytes().to_vec()),
            ("assets/logo.png".into(), logo()),
        ])
    );
    for path in [&root, &zip, &format!("{root}/files/index.html")] {
        assert_eq!(get(&group.f, path, None).await.0, 403);
        assert_eq!(get(&group.f, path, Some(&group.f.member)).await.0, 403);
    }
    assert_eq!(
        get(
            &group.f,
            &format!("{root}/files/assets/absent.js"),
            Some(&group.f.owner)
        )
        .await
        .0,
        404
    );
    let foreign = format!(
        "/api/workspaces/{}/website-projects/{old_id}",
        group.f.foreign
    );
    assert_ne!(get(&group.f, &foreign, Some(&group.f.owner)).await.0, 200);

    let model = Model::new(Arc::new({
        let old_id = old_id.clone();
        move |body| {
            let old_id = old_id.clone();
            Box::pin(async move {
                if has_tool_result(&body) {
                    assert_eq!(tool_result(&body)["delivered"], true);
                    finish("The updated version is ready.")
                } else {
                    let wire = body.to_string();
                    assert!(
                        wire.contains("websiteProjects")
                            && wire.contains(&old_id)
                            && wire.contains("synthetic-site")
                    );
                    call(TOOL, request(UPDATED))
                }
            })
        }
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Deliver the revision of that same project.",
            "followUp",
            false,
        )
        .await;
    let second = group.done().await;
    let second = cards(&second);
    assert_eq!(second.len(), 2);
    let new = second
        .iter()
        .map(|m| &m["metadata"]["websiteProject"])
        .find(|project| project["id"] != old_id)
        .unwrap();
    assert_eq!(new["projectKey"], key);
    let (status, share) = group
        .f
        .request(
            "GET",
            &format!("{root}/share"),
            None,
            true,
            Some(&group.f.member),
        )
        .await;
    assert_eq!(status, 200, "{share}");
    assert_eq!(share["visibility"], "private");
    assert!(share["path"].is_null());
    let new_path = group.f.path(&format!(
        "/website-projects/{}/files/index.html",
        new["id"].as_str().unwrap()
    ));
    assert_eq!(
        get(&group.f, &new_path, Some(&group.f.owner)).await.2,
        UPDATED.as_bytes()
    );
    assert_eq!(
        get(
            &group.f,
            &format!("{root}/files/index.html"),
            Some(&group.f.owner)
        )
        .await
        .2,
        ENTRY.as_bytes()
    );
    group.close().await;
}

#[tokio::test]
async fn unsafe_stale_and_unregistered_assets_never_publish_projects() {
    let group = Group::new().await;
    let workspace = group.store.directory.join("workspace");
    let site = workspace.join("synthetic-site");
    std::fs::create_dir_all(&site).unwrap();
    std::fs::write(site.join("unregistered.css"), CSS).unwrap();
    std::fs::write(workspace.join("outside.css"), CSS).unwrap();
    std::os::unix::fs::symlink("../outside.css", site.join("linked.css")).unwrap();
    group
        .store
        .put(
            Table::Files,
            &json!({"id":"fixture-link","name":"synthetic-site/linked.css","type":"text/css"}),
        )
        .await
        .unwrap();
    let step = Arc::new(AtomicUsize::new(0));
    let calls = step.clone();
    let model = Model::new(Arc::new(move |_| {
        let calls = calls.clone();
        Box::pin(async move {
            let step = calls.fetch_add(1, Ordering::SeqCst);
            if step == 0 {
                return writes("index.html", ENTRY);
            }
            if step == 7 {
                return finish("No unsafe project was delivered.");
            }
            let mut input = request(ENTRY);
            let entry = input["files"][0].clone();
            let asset = |path: &str| json!({"path":path,"sha256":hash(CSS)});
            input["files"] = match step {
                1 => json!([entry, asset("../outside.css")]),
                2 => json!([entry, asset(".env.json")]),
                3 => json!([entry, asset("linked.css")]),
                4 => json!([entry, asset("unregistered.css")]),
                5 => json!([entry, {"path":"INDEX.HTML","sha256":hash(ENTRY)}]),
                6 => json!([{"path":"index.html","sha256":"0".repeat(64)}]),
                _ => panic!("Unexpected synthetic call"),
            };
            call(TOOL, input)
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Try only the synthetic invalid website requests.",
            "followUp",
            false,
        )
        .await;
    assert!(cards(&group.done().await).is_empty());
    let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM website_projects")
        .fetch_one(&group.store.pool)
        .await
        .unwrap();
    assert_eq!(snapshots, 0);
    assert_eq!(step.load(Ordering::SeqCst), 8);
    group.close().await;
}
