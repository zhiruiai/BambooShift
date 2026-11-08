mod agent_delegation_support;
mod agent_primary_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

const ENDPOINT: &str = "https://api.githubcopilot.com/mcp/readonly";
const FIXTURE_WORKER: &str = r#"
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const read = async () => JSON.parse((await lines.next()).value);
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const operation = await read();
assert.equal(operation.type, 'operation');
assert.equal(operation.endpoint.url, endpoint);
send({ type: 'authorize', id: 'mock-mcp-dispatch' });
assert.deepEqual(await read(), { type: 'authorization', id: 'mock-mcp-dispatch', allowed: true });
if (operation.op === 'tools') {
  send({ type: 'result', ok: true, result: catalog });
} else {
  assert.equal(operation.op, 'call');
  assert.deepEqual(operation.tool, catalog[0]);
  if (operation.expectedCatalog) assert.deepEqual(operation.expectedCatalog, catalog);
  await appendFile(log, JSON.stringify({
    arguments: operation.arguments, pinnedCatalog: !!operation.expectedCatalog,
  }) + '\n');
  const hold = `${log}.hold`;
  while (existsSync(hold)) await delay(20);
  send({ type: 'result', ok: true, result: { isError: false, text: 'Synthetic issue result' } });
}
"#;

fn catalog() -> Value {
    json!([{
        "name":"issue_read","description":"Get issue details.",
        "annotations":{"readOnlyHint":true},
        "inputSchema":{"type":"object","required":["method","owner","repo","issue_number"],
            "properties":{"method":{"type":"string","enum":["get","get_comments"]},
            "owner":{"type":"string"},"repo":{"type":"string"},"issue_number":{"type":"number"}}}
    }])
}

fn arguments(issue: u64) -> Value {
    json!({"method":"get","owner":"openbot-fixture","repo":"workbench","issue_number":issue})
}

fn install_runtime(group: &mut Group) -> PathBuf {
    let mut config = (*group.f.state.config).clone();
    let original_runtime = config.runtime_dir.clone();
    let runtime = group
        .f
        .directory
        .path()
        .join("interactive-approval-runtime");
    let log = runtime.join("external-dispatches.jsonl");
    let pi = runtime.join("packages/pi-worker");
    let mcp = runtime.join("packages/mcp-worker");
    for directory in [&pi, &mcp] {
        fs::create_dir_all(directory).unwrap();
    }
    let file_url = |path: &str| {
        url::Url::from_file_path(original_runtime.join(path))
            .unwrap()
            .to_string()
    };
    fs::write(
        pi.join("index.mjs"),
        format!(
            "import {{register}} from {}; register(); await import({});\n",
            json!(file_url("node_modules/tsx/dist/esm/api/index.mjs")),
            json!(file_url("server/workers/pi-worker/index.ts")),
        ),
    )
    .unwrap();
    fs::write(
        mcp.join("index.mjs"),
        format!(
            "const endpoint = {}; const log = {}; const catalog = {};\n{FIXTURE_WORKER}",
            json!(ENDPOINT),
            json!(log),
            catalog(),
        ),
    )
    .unwrap();
    config.runtime_dir = runtime;
    group.f.state.config = Arc::new(config);
    log
}

fn calls(log: &Path) -> Vec<Value> {
    match fs::read_to_string(log) {
        Ok(value) => value
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("Fixture dispatch log failed: {error}"),
    }
}

async fn connect(group: &Group) -> Value {
    let (status, value) = group.f.request(
        "POST", &group.f.path("/apps"),
        Some(json!({"name":"GitHub","url":ENDPOINT,"authType":"bearer","token":"synthetic-fixture-token","shared":true})),
        false, Some(&group.f.owner),
    ).await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["status"], "connected", "{value}");
    value
}

async fn send(group: &Group, conversation: &str, app: Option<&Value>) -> Value {
    let mut body = json!({"content":"Read the synthetic GitHub issue.","clientId":uuid::Uuid::new_v4().to_string(),"agentId":group.ids[0],"mode":"followUp"});
    if let Some(app) = app {
        body["appContext"] = json!({"connectionId":app["id"],"revision":app["revision"]});
    }
    let (status, value) = group
        .f
        .request(
            "POST",
            &group
                .f
                .path(&format!("/conversations/{conversation}/messages")),
            Some(body),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 202, "{value}");
    value["message"].clone()
}

fn receipts(messages: &[Value], input: &Value) -> Vec<Value> {
    messages
        .iter()
        .map(|message| &message["metadata"]["appAction"])
        .filter(|action| action["requester"]["messageId"] == input["id"])
        .cloned()
        .collect()
}

async fn pending(group: &Group, input: &Value) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let messages = group.store.list(Table::Messages).await.unwrap();
            if let Some(action) = receipts(&messages, input)
                .into_iter()
                .find(|a| a["status"] == "pending")
            {
                return action;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("The Pi tool did not post an approval for the specified request")
}

async fn decide(group: &Group, action: &Value, body: Value) -> Value {
    let (status, value) = group
        .f
        .request(
            "POST",
            &group.f.path(&format!(
                "/app-actions/{}/decision",
                action["id"].as_str().unwrap()
            )),
            Some(body),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value
}

async fn list_rules(group: &Group, member: bool) -> Value {
    let actor = if member {
        &group.f.member
    } else {
        &group.f.owner
    };
    let (status, value) = group
        .f
        .request(
            "GET",
            &group.f.path("/apps/approval-rules"),
            None,
            member,
            Some(actor),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value["rules"].clone()
}

fn finished(messages: &[Value], input: &Value) -> bool {
    messages.iter().any(|message| {
        message["metadata"]["inputMessageId"] == input["id"]
            && message["status"] == "done"
            && message["content"] == "Finished after checking the synthetic application result."
    })
}

async fn set_issue_access(group: &Group, app: &Value, enabled: bool) {
    let id = app["id"].as_str().unwrap();
    let path = group.f.path(&format!("/apps/{id}/tools"));
    let (status, tools) = group
        .f
        .request("GET", &path, None, false, Some(&group.f.owner))
        .await;
    assert_eq!(status, 200, "{tools}");
    let tool = &tools[0];
    assert_eq!(tool["name"], "issue_read");
    let (status, result) = group.f.request(
        "PUT", &format!("{path}/access"), Some(json!({"toolName":"issue_read","enabled":enabled,
        "expectedConnectionRevision":app["revision"],"expectedToolRevision":tool["access"]["revision"]})), false, Some(&group.f.owner),
    ).await;
    assert_eq!(status, 200, "{result}");
}

#[tokio::test]
async fn disabling_and_reenabling_github_issue_read_requires_fresh_interactive_approval() {
    let mut group = agent_primary_support::personal(Group::new().await).await;
    let log = install_runtime(&mut group);
    let app = connect(&group).await;
    let id = app["id"].clone();
    let model = Model::new(Arc::new(move |body| {
        let id = id.clone();
        Box::pin(async move {
            if body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .take_while(|message| message["role"] != "user")
                .any(|message| message["role"] == "tool")
            {
                return finish("Finished after checking the synthetic application result.");
            }
            call(
                "app_action",
                json!({"connectionId":id,"toolName":"issue_read","arguments":arguments(42)}),
            )
        })
    }))
    .await;
    group.configure(&model).await;

    let input = send(&group, &group.cid, Some(&app)).await;
    let approval = pending(&group, &input).await;
    let accepted = decide(&group, &approval, json!({"decision":"always_allow"})).await;
    assert_eq!(accepted["interactiveApproval"]["usage"], "saved");
    assert!(finished(&group.done().await, &input));
    assert_eq!(calls(&log).len(), 1);

    set_issue_access(&group, &app, false).await;
    assert_eq!(list_rules(&group, false).await, json!([]));
    let disabled = send(&group, &group.cid, None).await;
    let messages = group.done().await;
    assert!(finished(&messages, &disabled));
    assert!(receipts(&messages, &disabled).is_empty());
    assert_eq!(calls(&log).len(), 1);

    set_issue_access(&group, &app, true).await;
    assert_eq!(list_rules(&group, false).await, json!([]));
    let new_input = send(&group, &group.cid, Some(&app)).await;
    let pending = pending(&group, &new_input).await;
    assert_eq!(pending["interactiveApproval"]["eligible"], true);
    assert_eq!(calls(&log).len(), 1);
    decide(&group, &pending, json!({"approve":false})).await;
    group.done().await;
    assert_eq!(calls(&log).len(), 1);
    group.close().await;
}

#[tokio::test]
async fn selected_private_chat_reuses_one_exact_rule_and_never_automatically_dispatches_changed_scope()
 {
    let group = Group::new().await;
    let group_conversation = group.cid.clone();
    let mut group = agent_primary_support::personal(group).await;
    let log = install_runtime(&mut group);
    let app = connect(&group).await;
    let connection_id = app["id"].clone();
    let plan = Arc::new(Mutex::new((41, 1, "done")));
    let model_plan = plan.clone();
    let model = Model::new(Arc::new(move |body| {
        let (issue, repetitions, expected) = *model_plan.lock().unwrap();
        let connection_id = connection_id.clone();
        Box::pin(async move {
            let tool_receipts = body["messages"].as_array().unwrap().iter().rev()
                .take_while(|message| message["role"] != "user")
                .filter(|message| message["role"] == "tool")
                .collect::<Vec<_>>();
            if tool_receipts.len() < repetitions {
                return call("app_action", json!({"connectionId":connection_id,"toolName":"issue_read","arguments":arguments(issue)}));
            }
            if repetitions == 2 {
                let first: Value = serde_json::from_str(tool_receipts[0]["content"].as_str().unwrap()).unwrap();
                let second: Value = serde_json::from_str(tool_receipts[1]["content"].as_str().unwrap()).unwrap();
                assert_eq!(first["status"], expected);
                assert_eq!(first, second);
                if expected == "error" {
                    assert!(first.get("result").is_none());
                }
            }
            finish("Finished after checking the synthetic application result.")
        })
    })).await;
    group.configure(&model).await;

    let initial = send(&group, &group.cid, Some(&app)).await;
    let approval = pending(&group, &initial).await;
    assert_eq!(approval["requester"]["userId"], group.f.owner);
    assert_eq!(approval["interactiveApproval"]["eligible"], true);
    assert!(calls(&log).is_empty());
    let accepted = decide(&group, &approval, json!({"decision":"always_allow"})).await;
    let marker = &accepted["interactiveApproval"];
    assert_eq!(marker["usage"], "saved");
    let rule_id = marker["ruleId"].as_str().unwrap();
    group.done().await;
    assert_eq!(calls(&log).len(), 1);
    let listed = list_rules(&group, false).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], rule_id);
    assert_eq!(listed[0]["input"], arguments(41));
    assert!(!listed.to_string().contains("synthetic-fixture-token"));
    assert!(listed[0].get("digest").is_none());
    assert!(listed[0].get("credentialRef").is_none());
    assert_eq!(list_rules(&group, true).await, json!([]));

    *plan.lock().unwrap() = (41, 2, "done");
    let repeated = send(&group, &group.cid, Some(&app)).await;
    let messages = group.done().await;
    assert!(finished(&messages, &repeated));
    let outcomes = receipts(&messages, &repeated);
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0]["status"], "done");
    assert_eq!(outcomes[0]["result"]["text"], "Synthetic issue result");
    assert_eq!(outcomes[0]["interactiveApproval"]["usage"], "reused");
    assert_eq!(outcomes[0]["interactiveApproval"]["ruleId"], rule_id);
    assert_eq!(calls(&log).len(), 2);
    assert_eq!(
        calls(&log)[1],
        json!({"arguments":arguments(41),"pinnedCatalog":true})
    );

    for (issue, conversation, selected, eligible) in [
        (42, group.cid.as_str(), Some(&app), true),
        (41, group.cid.as_str(), None, false),
        (41, group_conversation.as_str(), Some(&app), false),
    ] {
        *plan.lock().unwrap() = (issue, 1, "rejected");
        let input = send(&group, conversation, selected).await;
        let approval = pending(&group, &input).await;
        assert_eq!(approval["arguments"], arguments(issue));
        assert_eq!(
            approval["interactiveApproval"]["eligible"] == true,
            eligible
        );
        assert_eq!(calls(&log).len(), 2);
        let denied = decide(&group, &approval, json!({"approve":false})).await;
        assert_eq!(denied["status"], "rejected");
        group.done().await;
    }
    assert_eq!(calls(&log).len(), 2);

    let hold = log.with_extension("jsonl.hold");
    fs::write(&hold, []).unwrap();
    *plan.lock().unwrap() = (41, 2, "error");
    let delayed = send(&group, &group.cid, Some(&app)).await;
    tokio::time::timeout(Duration::from_secs(20), async {
        while calls(&log).len() < 3 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The delayed MCP fixture did not reach external dispatch");
    let path = group.f.path(&format!("/apps/approval-rules/{rule_id}"));
    let (status, revoked) = group
        .f
        .request("DELETE", &path, None, false, Some(&group.f.owner))
        .await;
    assert_eq!(status, 200, "{revoked}");
    assert_eq!(revoked, json!({"ok":true}));
    fs::remove_file(hold).unwrap();
    let messages = group.done().await;
    assert!(finished(&messages, &delayed));
    let outcomes = receipts(&messages, &delayed);
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0]["status"], "error");
    assert!(outcomes[0].get("result").is_none());
    assert_eq!(calls(&log).len(), 3);
    assert_eq!(list_rules(&group, false).await, json!([]));

    *plan.lock().unwrap() = (41, 1, "rejected");
    let after_revoke = send(&group, &group.cid, Some(&app)).await;
    let approval = pending(&group, &after_revoke).await;
    assert_eq!(approval["interactiveApproval"]["eligible"], true);
    assert_eq!(calls(&log).len(), 3);
    assert_eq!(
        decide(&group, &approval, json!({"approve":false})).await["status"],
        "rejected"
    );
    group.done().await;
    assert_eq!(calls(&log).len(), 3);
    group.close().await;
}
