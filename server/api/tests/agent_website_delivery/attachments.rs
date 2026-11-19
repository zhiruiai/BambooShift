use super::*;

const CONTENT: &str = "session,room\r\nOpening,North\r\n";
const ASSET: &str = "data/venue.csv";

async fn upload(group: &Group, conversation: &str, bytes: &str) -> Value {
    let (status, file) = group.f.request(
        "POST",
        &group.f.path("/files"),
        Some(json!({"conversationId":conversation,"name":"source.csv","type":"text/csv","content":STANDARD.encode(bytes)})),
        false,
        Some(&group.f.owner),
    ).await;
    assert_eq!(status, 201, "{file}");
    file
}

fn publish(attachment: &Value, path: &str) -> axum::http::Response<Body> {
    call(
        TOOL,
        json!({"directory":"synthetic-site","title":"Synthetic website","entry":"index.html","files":[
            {"path":"index.html","sha256":hash(ENTRY)},
            {"path":path,"sha256":hash(CONTENT),"attachmentId":attachment["id"]}
        ]}),
    )
}

fn rejected(body: &Value, reason: &str) {
    let output = tool_output(body);
    assert!(output.contains(reason), "Expected {reason}: {output}");
}

#[tokio::test]
async fn uploaded_files_are_scoped_type_checked_and_archived_by_destination() {
    let group = Group::new().await;
    let (status, second) = group.f.request(
        "POST", &group.f.path("/conversations"),
        Some(json!({"title":"Another synthetic group","agentIds":[group.ids[1],group.ids[2]],"isGroup":true})),
        false, Some(&group.f.owner),
    ).await;
    assert_eq!(status, 201, "{second}");
    let foreign = upload(&group, second["id"].as_str().unwrap(), CONTENT).await;
    let own = upload(&group, &group.cid, CONTENT).await;
    let changed = upload(&group, &group.cid, "session,room\r\nOpening,South\r\n").await;
    let original_path = group
        .store
        .directory
        .join("workspace")
        .join(own["name"].as_str().unwrap());
    assert_ne!(own["name"], foreign["name"]);
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let model = Model::new(Arc::new(move |body| {
        let (counter, own, foreign, changed) = (
            counter.clone(),
            own.clone(),
            foreign.clone(),
            changed.clone(),
        );
        Box::pin(async move {
            match counter.fetch_add(1, Ordering::SeqCst) {
                0 => writes("index.html", ENTRY),
                1 => publish(&foreign, ASSET),
                2 => {
                    rejected(&body, "不存在");
                    publish(&own, "data/venue.js")
                }
                3 => {
                    rejected(&body, "无效");
                    publish(&changed, ASSET)
                }
                4 => {
                    rejected(&body, "已变化");
                    publish(&own, ASSET)
                }
                5 => {
                    assert_eq!(tool_result(&body)["delivered"], true);
                    publish(&changed, ASSET)
                }
                6 => {
                    rejected(&body, "已变化");
                    publish(&foreign, ASSET)
                }
                7 => {
                    rejected(&body, "不存在");
                    finish("The verified file is available.")
                }
                _ => panic!("Unexpected synthetic call"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send(
            "Deliver the verified schedule from this conversation.",
            "followUp",
            false,
        )
        .await;
    let messages = group.done().await;
    let published = cards(&messages);
    assert_eq!(calls.load(Ordering::SeqCst), 8);
    assert_eq!(published.len(), 1);
    let project = &published[0]["metadata"]["websiteProject"];
    assert_eq!(project["fileCount"], 2);
    let root = group.f.path(&format!(
        "/website-projects/{}",
        project["id"].as_str().unwrap()
    ));
    std::fs::remove_file(original_path).unwrap();
    let (status, _, manifest) = get(&group.f, &root, Some(&group.f.owner)).await;
    assert_eq!(status, 200);
    let manifest: Value = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(
        manifest["files"][0],
        json!({"path":ASSET,"mime":"text/csv","size":CONTENT.len(),"sha256":hash(CONTENT)})
    );
    let (status, _, asset) = get(
        &group.f,
        &format!("{root}/files/{ASSET}"),
        Some(&group.f.owner),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(asset, CONTENT.as_bytes());
    let (status, _, zip) = get(&group.f, &format!("{root}/download"), Some(&group.f.owner)).await;
    assert_eq!(status, 200);
    assert_eq!(
        read_zip(&zip),
        BTreeMap::from([
            (ASSET.to_owned(), CONTENT.as_bytes().to_vec()),
            ("index.html".to_owned(), ENTRY.as_bytes().to_vec())
        ])
    );
    group.close().await;
}
