mod agent_delegation_support;
mod agent_primary_support;
mod workspace_support;

use agent_delegation_support::{Group, Model, call, finish, role, wait_gate};
use axum::{Json, Router, routing::post};
use openbot_backend::{agent::AgentRegistry, workspace::Table};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{Mutex, Semaphore};

const QUERY: &str = "site:pi.dev Pi coding agent architecture";
const SOURCE: &str = "https://example.com/approved-research";
const SIGNED: &str = "https://example.com/private?token=synthetic";
const FORGED: &str = "https://example.com/another-article";
const MARKER: &str = "Verified isolated provider fixture";
const REPLY: &str = "Finished the public research fixture.";

#[derive(Clone)]
struct Probe {
    requests: Arc<Mutex<Vec<Value>>>,
    hold: Arc<AtomicBool>,
    arrived: Arc<Semaphore>,
    release: Arc<Semaphore>,
}

struct Provider {
    origin: String,
    probe: Probe,
    task: tokio::task::JoinHandle<()>,
}

impl Provider {
    async fn start() -> Self {
        let probe = Probe {
            requests: Arc::new(Mutex::new(Vec::new())),
            hold: Arc::new(AtomicBool::new(false)),
            arrived: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
        };
        let shared = probe.clone();
        let app = Router::new().route("/mcp", post(move |Json(body): Json<Value>| {
            let probe = shared.clone();
            async move {
                let call = body["params"].clone();
                probe.requests.lock().await.push(call.clone());
                if probe.hold.swap(false, Ordering::SeqCst) {
                    probe.arrived.add_permits(1);
                    probe.release.acquire().await.unwrap().forget();
                }
                let result = match call["name"].as_str() {
                    Some("web_search_advanced_exa") => json!({"structuredContent":{"results":[
                        {"title":MARKER,"url":SOURCE,"text":"A public synthetic source."},
                        {"title":"Query-bearing URL","url":SIGNED,"text":"This URL must not be fetched."}
                    ]}}),
                    Some("web_fetch_exa") => json!({"content":[{"type":"text","text":format!("# {MARKER}\nURL: {SOURCE}\n\nApproved fixture page.") }]}),
                    unexpected => panic!("Unexpected provider tool: {unexpected:?}"),
                };
                Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            origin,
            probe,
            task,
        }
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn tool<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
    body["tools"]
        .as_array()?
        .iter()
        .find(|tool| tool["function"]["name"] == name)
        .map(|tool| &tool["function"]["parameters"])
}

fn last_result(body: &Value) -> &str {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
}

fn output(body: &Value) -> Value {
    let result = last_result(body);
    let (_, data) = result
        .split_once('\n')
        .unwrap_or_else(|| panic!("Missing provider output: {result}"));
    serde_json::from_str(data).unwrap()
}

fn check_offer(body: &Value) {
    let search = tool(body, "web_search").expect("Missing approved search tool");
    assert_eq!(search["properties"]["query"]["enum"], json!([QUERY]));
    assert!(search["properties"].get("limit").is_none());
    assert!(tool(body, "web_fetch").is_some());
}

fn search() -> axum::http::Response<axum::body::Body> {
    call("web_search", json!({"query":QUERY}))
}

async fn create(group: &Group, title: &str, approved: bool, enabled: bool) -> Value {
    let mut body = json!({"title":title,"prompt":"Summarize public source evidence.","agentId":group.ids[0],
        "conversationId":group.cid,"enabled":enabled,"schedule":"interval:60"});
    if approved {
        body["publicSearchQueries"] = json!([QUERY]);
    }
    let (status, value) = group
        .f
        .request(
            "POST",
            &group.f.path("/routines"),
            Some(body),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 201, "{value}");
    value
}

fn configuration(routine: &Value) -> Value {
    let mut config = json!({});
    for key in [
        "agentId",
        "conversationId",
        "title",
        "prompt",
        "schedule",
        "timeZone",
        "enabled",
        "publicSearchQueries",
    ] {
        if let Some(value) = routine.get(key) {
            config[key] = value.clone();
        }
    }
    config
}

async fn test_run(group: &Group, routine: &Value) {
    let request = json!({"kind":"run","routineId":routine["id"],"requestId":uuid::Uuid::new_v4().to_string(),"expectedRoutine":configuration(routine)});
    let (status, value) = group
        .f
        .request(
            "POST",
            &group.f.path("/routine-operations"),
            Some(request),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 202, "{value}");
}

async fn schedule(group: &Group, routine: &Value) {
    let mut routine = routine.clone();
    let now = chrono::Utc::now();
    routine["nextRunAt"] = json!((now - chrono::Duration::seconds(10)).to_rfc3339());
    group.store.put(Table::Routines, &routine).await.unwrap();
    openbot_backend::scheduling::tick(&group.f.state, now.timestamp_millis())
        .await
        .unwrap();
}

async fn drain(group: &Group, expected: usize) {
    let messages = group.done().await;
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["role"] == "assistant"
                && message["status"] == "done"
                && message["content"] == REPLY)
            .count(),
        expected
    );
}

#[tokio::test]
async fn real_pi_runs_exact_reviewed_queries_and_follows_only_current_run_sources() {
    let mut group = agent_primary_support::personal(Group::new().await).await;
    let provider = Provider::start().await;
    group.f.state.agent_runs = Arc::new(AgentRegistry::with_web_fixture(&provider.origin).unwrap());
    let step = Arc::new(AtomicUsize::new(0));
    let driver = step.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = driver.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match step {
                0 => {
                    assert!(tool(&body, "web_search").is_none());
                    assert!(tool(&body, "web_fetch").is_none());
                    finish(REPLY)
                }
                1 => {
                    check_offer(&body);
                    call(
                        "web_search",
                        json!({"query":format!("{QUERY} unapproved appended text")}),
                    )
                }
                2 => {
                    assert!(!last_result(&body).contains(MARKER));
                    call("web_search", json!({"query":QUERY,"limit":1}))
                }
                3 => {
                    assert!(!last_result(&body).contains(MARKER));
                    call("web_fetch", json!({"url":FORGED}))
                }
                4 => {
                    assert!(!last_result(&body).contains(MARKER));
                    search()
                }
                5 => {
                    let output = output(&body);
                    assert_eq!(output["results"][0]["url"], SOURCE);
                    assert_eq!(output["reusedQuery"], false);
                    assert_eq!(output["remainingNewQueries"], 0);
                    search()
                }
                6 => {
                    assert_eq!(output(&body)["reusedQuery"], true);
                    call("web_fetch", json!({"url":SIGNED}))
                }
                7 => {
                    assert!(!last_result(&body).contains(MARKER));
                    call("web_fetch", json!({"url":SOURCE}))
                }
                8 => {
                    assert_eq!(output(&body)["page"]["text"], "Approved fixture page.");
                    finish(REPLY)
                }
                9 => {
                    check_offer(&body);
                    call("web_fetch", json!({"url":SOURCE}))
                }
                10 => {
                    assert!(!last_result(&body).contains(MARKER));
                    search()
                }
                11 => {
                    assert_eq!(output(&body)["results"][0]["title"], MARKER);
                    finish(REPLY)
                }
                _ => panic!("Unexpected Pi request {step}"),
            }
        })
    }))
    .await;
    group.configure(&model).await;

    let legacy = create(&group, "No network authorization", false, false).await;
    test_run(&group, &legacy).await;
    drain(&group, 1).await;
    assert!(provider.probe.requests.lock().await.is_empty());

    let manual = create(&group, "Approved manual research", true, false).await;
    test_run(&group, &manual).await;
    drain(&group, 2).await;
    let manual_calls = provider.probe.requests.lock().await.clone();
    assert_eq!(manual_calls.len(), 2, "{manual_calls:?}");
    assert_eq!(
        manual_calls[0]["arguments"],
        json!({"query":QUERY,"numResults":5,"textMaxCharacters":600})
    );
    assert_eq!(
        manual_calls[1]["arguments"],
        json!({"urls":[SOURCE],"maxCharacters":12000})
    );

    let scheduled = create(&group, "Approved scheduled research", true, true).await;
    schedule(&group, &scheduled).await;
    drain(&group, 3).await;
    let requests = provider.probe.requests.lock().await;
    assert_eq!(requests.len(), 3, "{requests:?}");
    assert_eq!(requests[2], manual_calls[0]);
    let cards = group
        .store
        .list(Table::Messages)
        .await
        .unwrap()
        .into_iter()
        .filter(|message| message["kind"] == "web_research")
        .collect::<Vec<_>>();
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[0]["metadata"]["webResearch"]["searches"], 1);
    assert_eq!(cards[0]["metadata"]["webResearch"]["cachedSearches"], 1);
    assert_eq!(cards[0]["metadata"]["webResearch"]["pagesRead"], 1);
    assert_eq!(cards[0]["metadata"]["webResearch"]["issues"], json!([]));
    assert_eq!(cards[1]["metadata"]["webResearch"]["searches"], 1);
    assert_eq!(step.load(Ordering::SeqCst), 12);
    drop(requests);
    group.close().await;
}

#[tokio::test]
async fn revoking_the_owner_scope_drops_an_in_flight_provider_result_and_prevents_later_searches() {
    let mut group = agent_primary_support::personal(Group::new().await).await;
    let provider = Provider::start().await;
    group.f.state.agent_runs = Arc::new(AgentRegistry::with_web_fixture(&provider.origin).unwrap());
    provider.probe.hold.store(true, Ordering::SeqCst);
    let step = Arc::new(AtomicUsize::new(0));
    let driver = step.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = driver.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match step {
                0 => {
                    check_offer(&body);
                    search()
                }
                1 => {
                    assert!(!last_result(&body).contains(MARKER));
                    assert!(last_result(&body).contains("搜索授权已变化"));
                    finish(REPLY)
                }
                2 => {
                    assert!(tool(&body, "web_search").is_none());
                    assert!(tool(&body, "web_fetch").is_none());
                    finish(REPLY)
                }
                _ => panic!("Unexpected Pi request {step}"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let routine = create(&group, "Revoke public research", true, false).await;
    test_run(&group, &routine).await;
    wait_gate(&provider.probe.arrived).await;
    let id = routine["id"].as_str().unwrap();
    let (status, revoked) = group
        .f
        .request(
            "PATCH",
            &group.f.path(&format!("/routines/{id}")),
            Some(json!({"publicSearchQueries":[],"expectedRoutine":configuration(&routine)})),
            false,
            Some(&group.f.owner),
        )
        .await;
    assert_eq!(status, 200, "{revoked}");
    assert!(revoked.get("publicSearchQueries").is_none());
    provider.probe.release.add_permits(1);
    drain(&group, 1).await;
    assert_eq!(provider.probe.requests.lock().await.len(), 1);

    test_run(&group, &revoked).await;
    drain(&group, 2).await;
    assert_eq!(provider.probe.requests.lock().await.len(), 1);
    assert_eq!(step.load(Ordering::SeqCst), 3);
    assert!(
        group
            .store
            .list(Table::Messages)
            .await
            .unwrap()
            .iter()
            .all(|message| message["kind"] != "web_research")
    );
    group.close().await;
}

#[tokio::test]
async fn unapproved_manual_group_routines_cannot_search_through_a_delegated_bot() {
    const CHILD: &str = "The synthetic delegate completed without public research.";
    let group = Group::new().await;
    let target = group.ids[1].clone();
    let step = Arc::new(AtomicUsize::new(0));
    let driver = step.clone();
    let model = Model::new(Arc::new(move |body| {
        let step = driver.fetch_add(1, Ordering::SeqCst);
        let target = target.clone();
        Box::pin(async move {
            assert!(tool(&body, "web_search").is_none());
            assert!(tool(&body, "web_fetch").is_none());
            match step {
                0 => call(
                    "delegate",
                    json!({"agentId":target,"task":"Complete a synthetic subtask."}),
                ),
                1 => {
                    assert_eq!(role(&body), 1);
                    finish(CHILD)
                }
                2 => {
                    assert!(last_result(&body).contains(CHILD));
                    finish(REPLY)
                }
                _ => panic!("Unexpected Pi request {step}"),
            }
        })
    }))
    .await;
    group.configure(&model).await;
    let routine = create(&group, "Legacy group routine", false, false).await;
    test_run(&group, &routine).await;
    drain(&group, 1).await;
    assert_eq!(step.load(Ordering::SeqCst), 3);
    assert!(
        group
            .store
            .list(Table::Messages)
            .await
            .unwrap()
            .iter()
            .all(|message| message["kind"] != "web_research")
    );
    group.close().await;
}
