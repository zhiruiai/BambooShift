mod shared_bots_support;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shared_bots_support::*;

async fn file(s: &Shared, name: &str, bytes: &[u8]) -> Value {
    let path = s.source.directory.join("workspace").join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
    let value = json!({"id":id(),"name":name,"size":bytes.len(),"type":"text/plain","createdAt":"2026-01-01T00:00:00.000Z"});
    s.source.put(Table::Files, &value).await.unwrap();
    value
}
async fn inspect(s: &Shared, id: &Value) -> Value {
    let (status, value) =
        s.f.request(
            "GET",
            &format!("{}/files/{}", s.sharing(), id.as_str().unwrap()),
            None,
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value
}
#[tokio::test]
async fn file_grants_bind_exact_content_and_never_copy_source_paths_or_private_files() {
    let mut s = Shared::new().await;
    let registered = file(&s, "folder/report.txt", b"approved version").await;
    file(&s, "secret.txt", b"NOT_AUTHORIZED").await;
    let granted = inspect(&s, &registered["id"]).await;
    assert_eq!(granted["name"], "report.txt");
    assert!(!granted.to_string().contains("folder/"));
    let hash = |v: &[u8]| hex::encode(Sha256::digest(v));
    let expected = hash(
        serde_json::to_string(&json!([
            registered["id"],
            "folder/report.txt",
            "text/plain",
            "2026-01-01T00:00:00.000Z",
            16,
            hash(b"approved version")
        ]))
        .unwrap()
        .as_bytes(),
    );
    assert_eq!(
        granted["revision"], expected,
        "Node compatible revision format"
    );
    s.update(json!({"files":[{"fileId":registered["id"],"revision":granted["revision"]}]}))
        .await;
    let receipt = s.add().await;
    let resolved = resolve(&s, &receipt).await;
    assert_eq!(resolved.files, vec![granted.clone()]);
    let data = resolved
        .grant
        .read_file(&s.f.state, registered["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(data.name, "report.txt");
    assert_eq!(data.bytes, b"approved version");
    assert!(
        resolved
            .grant
            .read_file(&s.f.state, "secret")
            .await
            .is_err()
    );
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    assert!(target.list(Table::Files).await.unwrap().is_empty());
    std::fs::write(
        s.source.directory.join("workspace/folder/report.txt"),
        b"new unauthorized content",
    )
    .unwrap();
    assert_eq!(
        resolved
            .grant
            .authorize(&s.f.state)
            .await
            .unwrap_err()
            .status,
        403
    );
    let (status, views) =
        s.f.request(
            "GET",
            &format!("/api/shared-bots/{}/files", s.share["id"].as_str().unwrap()),
            None,
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(views[0]["status"], "changed");
    assert_eq!(views[0]["name"], "report.txt");
    assert_eq!(views[0]["revision"], granted["revision"]);
    let old_url = format!(
        "/api/shared-bots/{}/files/{}/download?revision={}",
        s.share["id"].as_str().unwrap(),
        registered["id"].as_str().unwrap(),
        granted["revision"].as_str().unwrap()
    );
    assert_eq!(
        s.f.request("GET", &old_url, None, true, Some(&s.f.member))
            .await
            .0,
        409
    );
    let new = inspect(&s, &registered["id"]).await;
    s.update(json!({"files":[{"fileId":registered["id"],"revision":new["revision"]}]}))
        .await;
    assert_eq!(
        s.f.request("GET", &old_url, None, true, Some(&s.f.member))
            .await
            .0,
        403
    );
    let fresh = resolve(&s, &receipt).await;
    assert_eq!(
        fresh
            .grant
            .read_file(&s.f.state, registered["id"].as_str().unwrap())
            .await
            .unwrap()
            .bytes,
        b"new unauthorized content"
    );
    s.close().await;
}
#[tokio::test]
async fn file_inspection_refuses_links_and_search_reaches_beyond_first_two_hundred() {
    use std::os::unix::fs::symlink;
    let s = Shared::new().await;
    let regular = file(&s, "regular.txt", b"canary").await;
    let linked = file(&s, "link.txt", b"").await;
    let linked_path = s.source.directory.join("workspace/link.txt");
    std::fs::remove_file(&linked_path).unwrap();
    symlink(
        s.source.directory.join("workspace/regular.txt"),
        &linked_path,
    )
    .unwrap();
    assert_eq!(
        s.f.request(
            "GET",
            &format!("{}/files/{}", s.sharing(), linked["id"].as_str().unwrap()),
            None,
            false,
            Some(&s.f.owner)
        )
        .await
        .0,
        409
    );
    let _hard = file(&s, "hard.txt", b"").await;
    let hard_path = s.source.directory.join("workspace/hard.txt");
    std::fs::remove_file(&hard_path).unwrap();
    std::fs::hard_link(s.source.directory.join("workspace/regular.txt"), hard_path).unwrap();
    assert_eq!(
        s.f.request(
            "GET",
            &format!("{}/files/{}", s.sharing(), regular["id"].as_str().unwrap()),
            None,
            false,
            Some(&s.f.owner)
        )
        .await
        .0,
        409
    );
    for n in 0..205 {
        s.source.put(Table::Files,&json!({"id":id(),"name":format!("item-{n:03}.txt"),"size":0,"type":"text/plain","createdAt":"2026-01-01T00:00:00.000Z"})).await.unwrap();
    }
    let (_, all) =
        s.f.request(
            "GET",
            &format!("{}/files", s.sharing()),
            None,
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(all["truncated"], true);
    assert_eq!(all["files"].as_array().unwrap().len(), 200);
    let (_, one) =
        s.f.request(
            "GET",
            &format!("{}/files?query=item-204", s.sharing()),
            None,
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(one["files"].as_array().unwrap().len(), 1);
    assert_eq!(one["files"][0]["name"], "item-204.txt");
    s.close().await;
}
#[tokio::test]
async fn source_app_catalog_is_whitelisted_hash_exact_and_used_grants_revoke_on_change() {
    let mut s = Shared::new().await;
    let app = id();
    let rev = id();
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_connections(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    )
    .execute(&s.source.pool)
    .await
    .unwrap();
    let raw_schema = r#"{"type":"object","properties":{"z":{"type":"string"},"a":{"type":"number"}},"required":["z"]}"#;
    let raw = format!(
        r#"{{"id":"{app}","name":"Source App","status":"connected","revision":"{rev}","url":"https://private.example.test/mcp","token":"PRIVATE_API_KEY","tools":[{{"name":"read_report","description":"Read report","inputSchema":{raw_schema}}}],"credentialGeneration":"old"}}"#
    );
    sqlx::query("INSERT INTO app_connections VALUES(?,?)")
        .bind(&app)
        .bind(&raw)
        .execute(&s.source.pool)
        .await
        .unwrap();
    let path = format!("{}/apps/{app}", s.sharing());
    let (status, catalog) =
        s.f.request("GET", &path, None, false, Some(&s.f.owner))
            .await;
    assert_eq!(status, 200, "{catalog}");
    assert!(!catalog.to_string().contains("PRIVATE_API_KEY"));
    assert!(!catalog.to_string().contains("private.example.test"));
    let expected = hex::encode(Sha256::digest(
        format!(
            r#"{{"name":"read_report","description":"Read report","inputSchema":{raw_schema}}}"#
        )
        .as_bytes(),
    ));
    assert_eq!(catalog["tools"][0]["revision"], expected);
    s.update(json!({"apps":[{"connectionId":app,"connectionRevision":rev,"tools":[{"name":"read_report","revision":expected}]}]})).await;
    let receipt = s.add().await;
    let resolved = resolve(&s, &receipt).await;
    let initial_apps_revision = resolved.agent["sharedBot"]["appsRevision"].clone();
    let tool = resolved
        .grant
        .authorize_app(&s.f.state, &app, "read_report")
        .await
        .unwrap();
    assert_eq!(tool["name"], "read_report");
    assert!(
        resolved
            .grant
            .authorize_app(&s.f.state, &app, "not_granted")
            .await
            .is_err()
    );
    sqlx::query(
        "UPDATE app_connections SET data=json_set(data,'$.credentialGeneration','new') WHERE id=?",
    )
    .bind(&app)
    .execute(&s.source.pool)
    .await
    .unwrap();
    resolved.grant.authorize(&s.f.state).await.unwrap();
    assert_eq!(
        resolve(&s, &receipt).await.agent["sharedBot"]["appsRevision"],
        initial_apps_revision
    );
    sqlx::query("UPDATE app_connections SET data=json_set(data,'$.tools[0].description','Changed') WHERE id=?").bind(&app).execute(&s.source.pool).await.unwrap();
    assert_eq!(
        resolved
            .grant
            .authorize(&s.f.state)
            .await
            .unwrap_err()
            .status,
        403
    );
    assert_ne!(
        resolve(&s, &receipt).await.agent["sharedBot"]["appsRevision"],
        initial_apps_revision
    );
    let (_, views) =
        s.f.request(
            "GET",
            &format!("/api/shared-bots/{}/apps", s.share["id"].as_str().unwrap()),
            None,
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(views[0]["status"], "changed");
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let files = std::fs::read_to_string(target.directory.join("config/models.private.json"))
        .unwrap_or_default();
    assert!(!files.contains("PRIVATE_API_KEY"));
    s.close().await;
}

#[tokio::test]
async fn shared_app_grants_pin_each_tool_generation_and_keep_enabled_siblings() {
    let mut s = Shared::new().await;
    let app = id();
    let revision = id();
    let target = "read.report";
    let sibling = "notes/read";
    let tool = |name| json!({"name":name,"description":"Read synthetic evidence","inputSchema":{"type":"object"}});
    let connection = json!({"id":app,"name":"Source controls fixture","status":"connected","revision":revision,
        "authType":"none","url":"https://fixture.example.test/mcp","tools":[tool(target),tool(sibling)]});
    sqlx::query("INSERT INTO app_connections VALUES(?,?)")
        .bind(&app)
        .bind(connection.to_string())
        .execute(&s.source.pool)
        .await
        .unwrap();
    let inspect = format!("{}/apps/{app}", s.sharing());
    let manage = s.f.path(&format!("/apps/{app}/tools"));
    let public = |share: &Value| format!("/api/shared-bots/{}/apps", share["id"].as_str().unwrap());
    let (status, catalog) =
        s.f.request("GET", &inspect, None, false, Some(&s.f.owner))
            .await;
    assert_eq!(status, 200, "{catalog}");
    let original = |catalog: &Value| json!({"connectionId":app,"connectionRevision":revision,"tools":catalog["tools"].as_array().unwrap().iter().map(|t|json!({"name":t["name"],"revision":t["revision"]})).collect::<Vec<_>>()});
    s.update(json!({"apps":[original(&catalog)]})).await;
    let receipt = s.add().await;
    let old = resolve(&s, &receipt).await;
    old.grant
        .authorize_app(&s.f.state, &app, target)
        .await
        .unwrap();

    let mut proof =
        s.f.request("GET", &manage, None, false, Some(&s.f.owner))
            .await
            .1[0]["access"]["revision"]
            .clone();
    for enabled in [false, true] {
        let (status, result) = s.f.request("PUT", &format!("{manage}/access"), Some(json!({
            "toolName":target,"enabled":enabled,"expectedConnectionRevision":revision,"expectedToolRevision":proof,
        })), false, Some(&s.f.owner)).await;
        assert_eq!(status, 200, "{result}");
        proof = result["access"]["revision"].clone();
        assert!(old.grant.authorize(&s.f.state).await.is_err());
        let current = resolve(&s, &receipt).await;
        assert_eq!(current.apps[0]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(current.apps[0]["tools"][0]["name"], sibling);
        assert!(
            current
                .grant
                .authorize_app(&s.f.state, &app, target)
                .await
                .is_err()
        );
        assert_eq!(
            current
                .grant
                .authorize_app(&s.f.state, &app, sibling)
                .await
                .unwrap()["name"],
            sibling
        );
        let (_, views) =
            s.f.request("GET", &public(&s.share), None, true, Some(&s.f.member))
                .await;
        assert_eq!(views[0]["status"], "available");
        assert_eq!(views[0]["tools"], current.apps[0]["tools"]);
    }

    let (_, updated) =
        s.f.request("GET", &inspect, None, false, Some(&s.f.owner))
            .await;
    assert_ne!(
        updated["tools"][0]["revision"],
        catalog["tools"][0]["revision"]
    );
    assert_eq!(
        updated["tools"][1]["revision"],
        catalog["tools"][1]["revision"]
    );
    s.update(json!({"apps":[original(&updated)]})).await;
    let renewed = resolve(&s, &receipt).await;
    renewed
        .grant
        .authorize_app(&s.f.state, &app, target)
        .await
        .unwrap();
    renewed
        .grant
        .authorize_app(&s.f.state, &app, sibling)
        .await
        .unwrap();
    s.close().await;
}
