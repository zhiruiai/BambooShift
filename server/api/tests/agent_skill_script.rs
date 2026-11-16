#![cfg(target_os = "macos")]

mod agent_delegation_support;
mod common;
mod workspace_support;

use agent_delegation_support::{Model, call, finish};
use base64::{Engine, engine::general_purpose::STANDARD};
use common::{Reply, request};
use openbot_backend::{
    config::{Config, LocalDesktopConfig},
    db::State,
    product_router,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const SCRIPT: &str = "from pathlib import Path\nimport sys\nprint(Path('references/schema.txt').read_text().strip())\nprint(Path(sys.argv[1]).read_text().strip())\n";
const SCHEMA: &str = "SYNTHETIC_RELATIVE_RESOURCE";
const FIRST_CSV: &str = "item,cost\nfixture,12\n";

struct Session {
    router: axum::Router,
    prefix: String,
    cookie: String,
    user: String,
}

impl Session {
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Reply {
        request(
            &self.router,
            method,
            &format!("{}{path}", self.prefix),
            &self.cookie,
            body,
            &[("x-openbot-expected-user", &self.user)],
        )
        .await
    }

    async fn actions(&self) -> Vec<Value> {
        let reply = self.request("GET", "/computer/actions", None).await;
        assert_eq!(reply.status, 200, "{}", reply.value);
        reply.value.as_array().unwrap().clone()
    }

    async fn action_when(&self, marker: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Some(action) = self.actions().await.into_iter().find(&marker) {
                    return action;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("Waiting for a managed script action")
    }
}

#[tokio::test]
async fn managed_skill_runs_only_after_approval_with_exact_package_and_attached_input() {
    let directory = tempfile::tempdir().unwrap();
    let token = "a".repeat(64);
    let mut config = Config::local(directory.path());
    config.local_desktop = Some(LocalDesktopConfig {
        bootstrap_token: token.clone(),
        host_control: true,
        desktop_driver: None,
        accessibility_helper: None,
    });
    let state = State::open(config).await.unwrap();
    let router = product_router(state.clone());
    let opened = request(
        &router,
        "POST",
        "/api/account/local-session",
        "",
        Some(json!({})),
        &[("x-bambooshift-local-token", &token)],
    )
    .await;
    assert_eq!(opened.status, 200, "{}", opened.value);
    let wid = opened.value["workspaceId"].as_str().unwrap();
    let session = Session {
        router,
        prefix: format!("/api/workspaces/{wid}"),
        cookie: opened.cookie(),
        user: opened.value["user"]["id"].as_str().unwrap().to_owned(),
    };
    let boot = session.request("GET", "/bootstrap", None).await;
    assert_eq!(boot.status, 200, "{}", boot.value);
    let agent = boot.value["agents"][0]["id"].as_str().unwrap();
    let conversation = boot.value["conversations"][0]["id"].as_str().unwrap();
    let connected = session
        .request("POST", "/computer/connect", Some(json!({"mode":"local"})))
        .await;
    assert_eq!(connected.status, 200, "{}", connected.value);
    assert!(
        connected.value["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("local-skill-script-v1"))
    );
    let forged = session
        .request(
            "POST",
            "/computer/actions",
            Some(json!({"type":"local_skill_script","path":"scripts/profile.py"})),
        )
        .await;
    assert_eq!(forged.status, 400, "{}", forged.value);

    let draft = session.request("POST", "/skills", Some(json!({
        "agentId":agent,"name":"synthetic-csv","description":"Read a bounded synthetic CSV.",
        "content":"Run scripts/profile.py using the chat CSV and references/schema.txt.",
        "skillPackage":{"root":"synthetic-csv","frontmatter":{"license":"MIT"},"files":[
            {"path":"scripts/profile.py","base64":STANDARD.encode(SCRIPT)},
            {"path":"references/schema.txt","base64":STANDARD.encode(SCHEMA)}
        ]}
    }))).await;
    assert_eq!(draft.status, 201, "{}", draft.value);
    let skill_id = draft.value["id"].as_str().unwrap();
    let approved = session
        .request(
            "POST",
            &format!("/skills/{skill_id}/approve"),
            Some(json!({})),
        )
        .await;
    assert_eq!(approved.status, 200, "{}", approved.value);

    let file = session.request("POST", "/files", Some(json!({
        "name":"fixture.csv","conversationId":conversation,"type":"text/csv","content":STANDARD.encode(FIRST_CSV),
    }))).await;
    assert_eq!(file.status, 201, "{}", file.value);
    let file_id = file.value["id"].as_str().unwrap();
    let file_name = file.value["name"].as_str().unwrap();
    let tool_args = Arc::new(json!({"skillId":skill_id,"path":"scripts/profile.py",
        "args":["__SKILL_INPUT__"],"fileId":file_id}));
    let model = Model::new(Arc::new(move |body| {
        let args = tool_args.clone();
        Box::pin(async move {
            let messages = body["messages"].as_array().unwrap();
            if messages.iter().any(|message| message["role"] == "tool") {
                return finish("Synthetic approval finished.");
            }
            assert!(
                body["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["function"]["name"] == "run_skill_script")
            );
            call("run_skill_script", (*args).clone())
        })
    }))
    .await;
    let configured = session
        .request("PUT", "/settings", Some(model.config()))
        .await;
    assert_eq!(configured.status, 200, "{}", configured.value);
    let path = format!("/conversations/{conversation}/messages");
    let send = |text| json!({"agentId":agent,"content":text,"mode":"followUp","clientId":uuid::Uuid::new_v4().to_string(),"skillId":skill_id});

    for (text, mutate, full) in [
        ("Run the synthetic CSV workflow", false, false),
        ("Retry on the attached CSV", true, false),
        ("Fully authorized retry", false, true),
    ] {
        if full {
            let store = state.workspace.get(wid, wid).await.unwrap();
            std::fs::write(store.directory.join("workspace").join(file_name), FIRST_CSV).unwrap();
            let status = session.request("GET", "/computer/status", None).await;
            let granted = session.request("POST", "/computer/authorization", Some(json!({"mode":"full","expectedTargetRevision":status.value["targetRevision"]}))).await;
            assert_eq!(granted.status, 200, "{}", granted.value);
        }
        let run = session.request("POST", &path, Some(send(text))).await;
        assert_eq!(run.status, 202, "{}", run.value);
        let pending = session
            .action_when(|action| {
                action["type"] == "local_skill_script"
                    && if full {
                        action["authorization"]["mode"] == "full" && action["status"] == "done"
                    } else {
                        action["status"] == "pending"
                    }
            })
            .await;
        let id = pending["id"].as_str().unwrap();
        assert_eq!(pending["payload"]["input"]["fileId"], file_id);
        assert_eq!(pending["payload"]["input"]["name"], file_name);
        assert_eq!(pending["payload"]["input"]["bytes"], FIRST_CSV.len());
        assert_eq!(pending["payload"]["skillVersion"], 1);
        assert_eq!(
            pending["payload"]["manifestSha256"].as_str().unwrap().len(),
            64
        );
        if !full {
            assert!(pending.get("result").is_none());
        }
        if !full {
            assert!(!pending.to_string().contains(SCHEMA));
        }
        if mutate {
            let store = state.workspace.get(wid, wid).await.unwrap();
            std::fs::write(
                store.directory.join("workspace").join(file_name),
                "changed fixture data",
            )
            .unwrap();
        }
        if !full {
            let decision = session
                .request(
                    "POST",
                    &format!("/computer/actions/{id}/approve"),
                    Some(json!({})),
                )
                .await;
            assert_eq!(decision.status, 200, "{}", decision.value);
        }
        let result = session
            .action_when(|action| {
                action["id"] == id && matches!(action["status"].as_str(), Some("done" | "error"))
            })
            .await;
        if mutate {
            assert_eq!(result["status"], "error", "{result}");
            assert!(result.get("result").is_none());
        } else {
            assert_eq!(result["status"], "done", "{result}");
            assert_eq!(result["result"]["exitCode"], 0, "{result}");
            assert_eq!(result["result"]["stdout"], format!("{SCHEMA}\n{FIRST_CSV}"));
        }
        tokio::time::timeout(Duration::from_secs(35), async {
            loop {
                let boot = session.request("GET", "/bootstrap", None).await;
                if boot.value["runningRequests"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
    }
    state.close().await;
}
