mod agent_delegation_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, has_tool_result, role};
use axum::{body::Body, http::Response};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc};

// Observe the real Pi process's output without replacing its tool or model runtime.
fn observe_tools(group: &mut Group) -> PathBuf {
    let source = group.f.state.config.runtime_dir.clone();
    let runtime = group.f.directory.path().join("observed-pi-runtime");
    let package = runtime.join("packages/pi-worker");
    let log = runtime.join("delegation-events.jsonl");
    fs::create_dir_all(&package).unwrap();
    let file_url = |path: &str| {
        url::Url::from_file_path(source.join(path))
            .unwrap()
            .to_string()
    };
    fs::write(
        package.join("index.mjs"),
        format!(
            r#"
import {{ appendFileSync }} from 'node:fs';
import {{ register }} from {register};
const write = process.stdout.write.bind(process.stdout);
let pending = '';
process.stdout.write = (chunk, ...args) => {{
  pending += chunk.toString();
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {{
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    const frame = JSON.parse(line);
    if (frame.type === 'event' && frame.event.type === 'tool_execution_end'
        && frame.event.toolName === 'delegate') {{
      appendFileSync({log}, JSON.stringify(frame.event) + '\n');
    }}
  }}
  return write(chunk, ...args);
}};
register();
await import({worker});
"#,
            register = json!(file_url("node_modules/tsx/dist/esm/api/index.mjs")),
            worker = json!(file_url("server/workers/pi-worker/index.ts")),
            log = json!(log),
        ),
    )
    .unwrap();
    Arc::make_mut(&mut group.f.state.config).runtime_dir = runtime;
    log
}

async fn delegated_outcome(failed: bool) {
    let mut group = Group::new().await;
    let log = observe_tools(&mut group);
    let target = group.ids[1].clone();
    let model = Model::new(Arc::new(move |body| {
        let target = target.clone();
        Box::pin(async move {
            if role(&body) == 1 {
                return if failed {
                    Response::builder()
                        .status(503)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"error":{"message":"Synthetic child outage"}}"#,
                        ))
                        .unwrap()
                } else {
                    finish("Synthetic specialist result.")
                };
            }
            if !has_tool_result(&body) {
                return call(
                    "delegate",
                    json!({"agentId":target,"task":"Return the synthetic specialist result."}),
                );
            }
            let result = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["role"] == "tool")
                .unwrap();
            let details: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
            assert_eq!(
                details["status"],
                if failed { "error" } else { "completed" }
            );
            assert!(details["resultMessageId"].is_string());
            finish(if failed {
                "The specialist failed; delivery remains blocked."
            } else {
                "Reviewed the actual specialist result."
            })
        })
    }))
    .await;
    group.configure(&model).await;
    group
        .send("Coordinate the synthetic task.", "followUp", false)
        .await;
    let messages = group.done().await;
    let events = fs::read_to_string(log).unwrap();
    let events: Vec<Value> = events
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["isError"], failed, "{events:?}");
    let details = &events[0]["result"]["details"];
    let child = messages
        .iter()
        .find(|message| message["id"] == details["resultMessageId"])
        .unwrap();
    assert_eq!(child["status"], if failed { "error" } else { "done" });
    assert_eq!(details["content"], child["content"]);
    assert_eq!(details["conversationId"], group.cid);
    assert_eq!(details["agentId"], group.ids[1]);
    let parent = messages
        .iter()
        .find(|message| message["role"] == "assistant" && message["agentId"] == group.ids[0])
        .unwrap();
    // Reporting a blocked result is a successful conversation turn, not project acceptance.
    assert_eq!(parent["status"], "done");
    assert_eq!(
        model.calls.lock().await.len(),
        3,
        "No automatic child replay"
    );
    drop(model);
    group.close().await;
}

#[tokio::test]
async fn real_child_model_failure_is_a_failed_tool_with_its_actual_result() {
    delegated_outcome(true).await;
}

#[tokio::test]
async fn real_child_success_keeps_the_normal_tool_result() {
    delegated_outcome(false).await;
}
