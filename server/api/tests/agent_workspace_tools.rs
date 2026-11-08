mod agent_delegation_support;
mod document_support;
mod workspace_support;
use agent_delegation_support::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

// Successful end-to-end fixtures share the process-wide parser pool. Dedicated supervisor
// tests separately verify real overload, cancellation and capacity release after child exit.
static PARSER_FIXTURES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn configure_node(g: &mut Group) {
    if let Some(node) = std::env::var_os("OPENBOT_NODE") {
        Arc::make_mut(&mut g.f.state.config).node_binary = node.into();
    }
}
fn last_tool(body: &Value) -> Value {
    let message = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap())
        .expect("Expected actual structured tool output")
}

#[tokio::test]
async fn actual_pdf_and_docx_text_is_parsed_in_the_worker_then_delivered_to_pi() {
    let _parser_fixture = PARSER_FIXTURES.lock().await;
    let mut g = Group::new().await;
    configure_node(&mut g);
    for (name, bytes) in [
        ("report.pdf", document_support::pdf("REAL_AUTHORIZED_PDF")),
        ("plan.docx", document_support::docx("真实授权文档正文")),
    ] {
        let uploaded =
            g.f.request(
                "POST",
                &g.f.path("/files"),
                Some(json!({"name":name,"content":STANDARD.encode(bytes)})),
                false,
                Some(&g.f.owner),
            )
            .await;
        assert_eq!(uploaded.0, 201, "{}", uploaded.1);
    }
    let count = Arc::new(AtomicUsize::new(0));
    let step = count.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = step.clone();
        Box::pin(async move {
            match step.fetch_add(1, Ordering::SeqCst) {
                0 => call("workspace_read", json!({"path":"report.pdf"})),
                1 => {
                    assert!(
                        body.to_string().contains("REAL_AUTHORIZED_PDF"),
                        "Actual PDF tool response: {}",
                        body["messages"].as_array().unwrap().last().unwrap()
                    );
                    call("workspace_read", json!({"path":"plan.docx"}))
                }
                2 => {
                    assert!(
                        body.to_string().contains("真实授权文档正文"),
                        "Actual DOCX tool response: {}",
                        body["messages"].as_array().unwrap().last().unwrap()
                    );
                    finish("Actual PDF and DOCX body text was read.")
                }
                _ => panic!("Unexpected document model request"),
            }
        })
    }))
    .await;
    g.configure(&model).await;
    g.send(
        "Read only these synthetic authorized documents.",
        "followUp",
        false,
    )
    .await;
    let messages = g.done().await;
    assert_eq!(count.load(Ordering::SeqCst), 3);
    assert!(messages.iter().any(
        |m| m["status"] == "done" && m["content"] == "Actual PDF and DOCX body text was read."
    ));
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn legitimate_large_tool_arguments_and_image_results_cross_the_bounded_pi_protocol() {
    let _parser_fixture = PARSER_FIXTURES.lock().await;
    let mut g = Group::new().await;
    configure_node(&mut g);
    let mut seed = 0x12345678_u32;
    let pixels = (0..1024 * 1024 * 3)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as u8
        })
        .collect::<Vec<_>>();
    let image = image::RgbImage::from_raw(1024, 1024, pixels).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    assert!(png.get_ref().len() > 2 * 1024 * 1024);
    let upload=g.f.request("POST",&g.f.path("/files"),Some(json!({"name":"large.png","type":"image/png","content":STANDARD.encode(png.into_inner())})),false,Some(&g.f.owner)).await;
    assert_eq!(upload.0, 201, "{}", upload.1);
    let count = Arc::new(AtomicUsize::new(0));
    let step = count.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = step.clone();
        Box::pin(async move {
            match step.fetch_add(1, Ordering::SeqCst) {
                0 => call(
                    "workspace_write",
                    json!({"path":"large.txt","content":"中".repeat(800_000)}),
                ),
                1 => {
                    assert_eq!(last_tool(&body)["size"], 2_400_000);
                    call("workspace_read", json!({"path":"large.png"}))
                }
                2 => {
                    let image = body["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|m| m["content"].as_array())
                        .flatten()
                        .find_map(|p| p["image_url"]["url"].as_str())
                        .expect("A genuine image block must reach the model");
                    let bytes = STANDARD
                        .decode(image.strip_prefix("data:image/png;base64,").unwrap())
                        .unwrap();
                    assert!(bytes.len() > 2 * 1024 * 1024);
                    assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 1024);
                    finish("Large legal content crossed the bounded protocol intact.")
                }
                _ => panic!("Unexpected model request"),
            }
        })
    }))
    .await;
    let mut config = model.config();
    config["vision"] = json!(true);
    assert_eq!(
        g.f.request(
            "PUT",
            &g.f.path("/settings"),
            Some(config),
            false,
            Some(&g.f.owner)
        )
        .await
        .0,
        200
    );
    g.send("Use the synthetic large file and image.", "followUp", false)
        .await;
    let messages = g.done().await;
    assert_eq!(count.load(Ordering::SeqCst), 3);
    assert!(messages.iter().any(|m| m["status"] == "done"
        && m["content"] == "Large legal content crossed the bounded protocol intact."));
    assert_eq!(
        std::fs::read(g.store.directory.join("workspace/large.txt")).unwrap(),
        "中".repeat(800_000).as_bytes()
    );
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn real_pi_writes_appends_exactly_edits_and_reads_registered_unicode_files() {
    let _parser_fixture = PARSER_FIXTURES.lock().await;
    let mut g = Group::new().await;
    configure_node(&mut g);
    let step = Arc::new(AtomicUsize::new(0));
    let counter = step.clone();
    let model=Model::new(Arc::new(move|body|{let counter=counter.clone();Box::pin(async move{
        match counter.fetch_add(1,Ordering::SeqCst) {
            0=>call("workspace_write",json!({"path":"./reports/计划.csv","content":"姓名,数量\n原方案,1\n"})),
            1=>{let result=last_tool(&body);call("workspace_append",json!({"path":"reports/计划.csv","content":"新增,2\n","expectedSha256":result["sha256"]}))},
            2=>{let result=last_tool(&body);call("workspace_edit",json!({"path":"reports/计划.csv","oldText":"原方案","newText":"新方案","expectedSha256":result["sha256"]}))},
            3=>call("workspace_read",json!({"path":"reports/计划.csv"})),
            4=>{assert!(body.to_string().contains("新方案,1"), "Actual CSV tool response: {}", body["messages"].as_array().unwrap().last().unwrap());assert!(body.to_string().contains("新增,2"));call("workspace_list",json!({"path":"reports"}))},
            5=>{let result=last_tool(&body);assert_eq!(result["entries"].as_array().unwrap().len(),1);assert!(result["entries"][0]["fileId"].is_string());finish("The actual CSV was created, amended and read.")},
            _=>panic!("Unexpected extra model request"),
        }
    })})).await;
    g.configure(&model).await;
    g.send(
        "Create the synthetic report and verify the actual content.",
        "followUp",
        false,
    )
    .await;
    let messages = g.done().await;
    assert!(messages.iter().any(|m| {
        m["status"] == "done"
            && m["content"]
                .as_str()
                .is_some_and(|s| s.contains("actual CSV"))
    }));
    assert_eq!(step.load(Ordering::SeqCst), 6);
    assert_eq!(
        std::fs::read_to_string(g.store.directory.join("workspace/reports/计划.csv")).unwrap(),
        "姓名,数量\n新方案,1\n新增,2\n"
    );
    let files = g.store.list(Table::Files).await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["name"], "reports/计划.csv");
    assert_eq!(files[0]["conversationId"], g.cid);
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn stale_hash_and_ambiguous_edit_leave_bytes_and_file_metadata_unchanged() {
    let mut g = Group::new().await;
    configure_node(&mut g);
    let step = Arc::new(AtomicUsize::new(0));
    let counter = step.clone();
    let model=Model::new(Arc::new(move|body|{let counter=counter.clone();Box::pin(async move{
        match counter.fetch_add(1,Ordering::SeqCst) {
            0=>call("workspace_write",json!({"path":"notes.txt","content":"重复\n重复\n"})),
            1=>call("workspace_append",json!({"path":"notes.txt","content":"NOT ADDED","expectedSha256":"0".repeat(64)})),
            2=>{assert!(body.to_string().contains("文件版本已变化"));call("workspace_edit",json!({"path":"notes.txt","oldText":"重复","newText":"NOT REPLACED"}))},
            3=>{assert!(body.to_string().contains("待替换内容不唯一"));call("workspace_read",json!({"path":"../identity.sqlite"}))},
            4=>finish("The stale edit and escaped path were rejected."),
            _=>panic!("Unexpected model call"),
        }
    })})).await;
    g.configure(&model).await;
    g.send("Check safe file mutation conflicts.", "followUp", false)
        .await;
    g.done().await;
    assert_eq!(step.load(Ordering::SeqCst), 5);
    assert_eq!(
        std::fs::read_to_string(g.store.directory.join("workspace/notes.txt")).unwrap(),
        "重复\n重复\n"
    );
    assert_eq!(g.store.list(Table::Files).await.unwrap().len(), 1);
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn uploaded_image_reaches_a_vision_model_as_real_image_bytes_and_is_refused_without_vision() {
    let _parser_fixture = PARSER_FIXTURES.lock().await;
    let mut g = Group::new().await;
    configure_node(&mut g);
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        4,
        3,
        image::Rgba([80, 40, 190, 255]),
    ))
    .write_to(&mut png, image::ImageFormat::Png)
    .unwrap();
    let uploaded=g.f.request("POST",&g.f.path("/files"),Some(json!({"name":"picture.png","type":"image/png","content":STANDARD.encode(png.into_inner()),"conversationId":g.cid})),false,Some(&g.f.owner)).await;
    assert_eq!(uploaded.0, 201, "{}", uploaded.1);
    let model = Model::new(Arc::new(move |body| {
        Box::pin(async move {
            if !has_tool_result(&body) {
                return call("workspace_read", json!({"path":"picture.png"}));
            }
            let mut images = 0;
            for message in body["messages"].as_array().unwrap() {
                if let Some(parts) = message["content"].as_array() {
                    for part in parts {
                        if let Some(url) = part["image_url"]["url"].as_str() {
                            let bytes = STANDARD
                                .decode(url.strip_prefix("data:image/png;base64,").unwrap())
                                .unwrap();
                            let picture = image::load_from_memory(&bytes).unwrap();
                            assert_eq!((picture.width(), picture.height()), (4, 3));
                            images += 1;
                        }
                    }
                }
            }
            assert_eq!(images, 1);
            finish("The actual normalized image reached the vision model.")
        })
    }))
    .await;
    let mut config = model.config();
    config["vision"] = json!(true);
    assert_eq!(
        g.f.request(
            "PUT",
            &g.f.path("/settings"),
            Some(config),
            false,
            Some(&g.f.owner)
        )
        .await
        .0,
        200
    );
    g.send("Read the uploaded synthetic image.", "followUp", false)
        .await;
    let messages = g.done().await;
    assert_eq!(model.calls.lock().await.len(), 2);
    assert!(messages.iter().any(|m| m["status"] == "done"
        && m["content"] == "The actual normalized image reached the vision model."));
    drop(model);
    let text_model = Model::new(Arc::new(move |body| {
        Box::pin(async move {
            if !has_tool_result(&body) {
                call("workspace_read", json!({"path":"picture.png"}))
            } else {
                assert!(body.to_string().contains("未启用图片理解"));
                assert!(!body.to_string().contains("data:image/png;base64,"));
                finish("No image was sent to the text-only model.")
            }
        })
    }))
    .await;
    let mut config = text_model.config();
    config["vision"] = json!(false);
    assert_eq!(
        g.f.request(
            "PUT",
            &g.f.path("/settings"),
            Some(config),
            false,
            Some(&g.f.owner)
        )
        .await
        .0,
        200
    );
    g.send("Check the text-only model boundary.", "followUp", false)
        .await;
    let messages = g.done().await;
    assert_eq!(text_model.calls.lock().await.len(), 2);
    assert!(
        messages.iter().any(|m| m["status"] == "done"
            && m["content"] == "No image was sent to the text-only model.")
    );
    drop(text_model);
    g.close().await;
}
