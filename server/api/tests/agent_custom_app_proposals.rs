mod agent_delegation_support;
mod shared_bots_support;
mod workspace_support;
use agent_delegation_support::{Group, Model, call, finish, has_tool_result};
use openbot_backend::{db::State, workspace::Table};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const TOOL: &str = "suggest_custom_app_connection";
const URL: &str = "https://mcp.synthetic.invalid/custom/";
fn advertised(body: &Value) -> bool {
    body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["function"]["name"] == TOOL)
}
fn cards(messages: &[Value]) -> Vec<&Value> {
    messages
        .iter()
        .filter(|m| m["metadata"]["appConnectionProposal"]["kind"] == "custom_mcp")
        .collect()
}
async fn direct(g: &Group) {
    let mut chat = g
        .store
        .get(Table::Conversations, &g.cid)
        .await
        .unwrap()
        .unwrap();
    chat["isGroup"] = json!(false);
    chat["agentIds"] = json!([g.ids[0]]);
    g.store.put(Table::Conversations, &chat).await.unwrap();
}
async fn personal() -> Group {
    let g = Group::new().await;
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&g.f.workspace)
        .execute(&g.f.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id<>?")
        .bind(&g.f.workspace)
        .bind(&g.f.owner)
        .execute(&g.f.db)
        .await
        .unwrap();
    direct(&g).await;
    g
}
fn suggest(url: &str) -> axum::http::Response<axum::body::Body> {
    call(
        TOOL,
        json!({"url":url,"reason":"Review this exact owner-supplied MCP endpoint."}),
    )
}

#[tokio::test]
async fn real_pi_personal_thread_proposes_once_without_connect_and_recovery_preserves_it() {
    let g = personal().await;
    let step = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |body| {
        let step = step.clone();
        Box::pin(async move {
            assert!(advertised(&body));
            match step.fetch_add(1, Ordering::SeqCst) {
                0 => suggest("https://MCP.SYNTHETIC.INVALID:443/custom/"),
                1 => suggest(URL),
                _ => finish("The review card is only a suggestion; nothing has connected."),
            }
        })
    }))
    .await;
    g.configure(&model).await;
    let thread = "synthetic-custom-thread";
    g.store.put(Table::Messages, &json!({"id":thread,"conversationId":g.cid,"role":"user","userId":g.f.owner,"kind":"text","content":"Unrelated thread origin"})).await.unwrap();
    let sent = g.f.request("POST", &g.f.path(&format!("/conversations/{}/messages",g.cid)), Some(json!({"content":format!("Let's connect <{URL}>"),"clientId":"custom-proposal-one","agentId":g.ids[0],"threadRootId":thread})), false, Some(&g.f.owner)).await;
    assert_eq!(sent.0, 202, "{}", sent.1);
    let messages = g.done().await;
    assert!(messages.iter().any(|m| m["content"]
        == "The review card is only a suggestion; nothing has connected."
        && m["status"] == "done"));
    let cards = cards(&messages);
    assert_eq!(cards.len(), 1, "{messages:?}");
    let card = cards[0];
    let proposal = &card["metadata"]["appConnectionProposal"];
    assert_eq!(proposal["url"], URL);
    assert_eq!(proposal["name"], "mcp.synthetic.invalid");
    assert_eq!(card["threadRootId"], thread);
    assert_eq!(card["agentId"], g.ids[0]);
    assert_eq!(proposal["requester"]["messageId"], sent.1["message"]["id"]);
    assert_eq!(proposal["requester"]["userId"], g.f.owner);
    assert!(proposal.get("providerId").is_none());
    assert!(proposal.get("authType").is_none());
    assert!(
        proposal["toolCallId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    let apps: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_connections")
        .fetch_one(&g.store.pool)
        .await
        .unwrap();
    let oauth: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_oauth_flows")
        .fetch_one(&g.store.pool)
        .await
        .unwrap();
    assert_eq!((apps, oauth), (0, 0));
    assert_eq!(model.calls.lock().await.len(), 3);
    let cfg = g.f.state.config.clone();
    let expected = card.clone();
    g.f.state.close().await;
    let recovered = State::open((*cfg).clone()).await.unwrap();
    let store = recovered
        .workspace
        .get(&g.f.workspace, &g.f.workspace)
        .await
        .unwrap();
    assert_eq!(
        store
            .get(Table::Messages, expected["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap(),
        expected
    );
    assert!(
        recovered
            .agent_runs
            .requests(&g.f.workspace)
            .await
            .is_empty()
    );
    assert_eq!(model.calls.lock().await.len(), 3);
    recovered.close().await;
    g.close().await;
}

#[tokio::test]
async fn actual_pi_rejects_fabricated_prefix_history_quotes_and_official_aliases() {
    let g = personal().await;
    g.store.put(Table::Messages,&json!({"id":"previous-url","conversationId":g.cid,"role":"user","userId":g.f.owner,"kind":"text","content":"https://history.example.org/mcp"})).await.unwrap();
    let candidates = Arc::new(vec![
        "https://fabricated.example.org/mcp".to_string(),
        "https://prefix.example.org/mcp".into(),
        "https://history.example.org/mcp".into(),
        "https://quoted.example.org/mcp".into(),
        "https://code.example.org/mcp".into(),
        "https://block.example.org/mcp".into(),
        "https://inline.example.org/mcp".into(),
        "https://substring.example.org/mcp".into(),
        "https://query.example.org/mcp".into(),
        "https://slash.example.org/mcp".into(),
        "https://punctuation.example.org/mcp".into(),
        "https://unicode.example.org/mcp".into(),
        "https://adjacent.example.org/mcp".into(),
        "https://lazy.example.org/mcp".into(),
        "https://nested.example.org/mcp".into(),
        "https://mcp.notion.com/mcp/".into(),
        "http://public.example.org/mcp".into(),
        format!("https://length.example.org/{}", "界".repeat(500)),
    ]);
    let step = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |body| {
        let candidates = candidates.clone();
        let step = step.clone();
        Box::pin(async move {
            assert!(advertised(&body));
            let index = step.fetch_add(1, Ordering::SeqCst);
            if index < candidates.len() {
                suggest(&candidates[index])
            } else {
                finish("All fabricated or non-plain-source proposals were refused.")
            }
        })
    }))
    .await;
    g.configure(&model).await;
    g.send("Use only this message. https://prefix.example.org/mcp/longer https://slash.example.org/mcp/\n\"https://quoted.example.org/mcp\"\n```\nhttps://code.example.org/mcp\n```\n> https://block.example.org/mcp\n`https://inline.example.org/mcp`\nprefixhttps://substring.example.org/mcp\nhttps://query.example.org/mcp?token=SYNTHETIC\nhttps://mcp.notion.com/mcp/\nhttps://punctuation.example.org/mcp)\nhttps://unicode.example.org/mcp。suffix\nhttps://adjacent.example.org/mcp`ignored`\n> Earlier quotation\nhttps://lazy.example.org/mcp\n\n````\n```\nhttps://nested.example.org/mcp\n````", "followUp",false).await;
    let messages = g.done().await;
    assert!(cards(&messages).is_empty(), "{messages:?}");
    assert!(messages.iter().any(|m| m["content"]
        == "All fabricated or non-plain-source proposals were refused."
        && m["status"] == "done"));
    g.close().await;
}

#[tokio::test]
async fn bare_path_punctuation_is_preserved_instead_of_authorizing_a_shorter_endpoint() {
    let g = personal().await;
    let urls = Arc::new(vec![
        "https://punctuation.example.org/mcp)",
        "https://unicode.example.org/mcp。suffix",
    ]);
    let candidates = urls.clone();
    let step = Arc::new(AtomicUsize::new(0));
    let model = Model::new(Arc::new(move |_| {
        let candidates = candidates.clone();
        let step = step.clone();
        Box::pin(async move {
            let i = step.fetch_add(1, Ordering::SeqCst);
            if i < candidates.len() {
                suggest(candidates[i])
            } else {
                finish("Both exact paths are preserved.")
            }
        })
    }))
    .await;
    g.configure(&model).await;
    g.send(
        &format!("Review these exact endpoints:\n{}\n{}", urls[0], urls[1]),
        "followUp",
        false,
    )
    .await;
    let messages = g.done().await;
    let cards = cards(&messages);
    assert_eq!(cards.len(), 2, "{messages:?}");
    for original in urls.iter() {
        let expected = url::Url::parse(original).unwrap().to_string();
        assert!(
            cards
                .iter()
                .any(|m| m["metadata"]["appConnectionProposal"]["url"] == expected)
        );
    }
    assert!(
        messages
            .iter()
            .any(|m| m["content"] == "Both exact paths are preserved." && m["status"] == "done")
    );
    g.close().await;
}

#[tokio::test]
async fn team_owner_direct_member_and_personal_group_cannot_advertise_or_force_custom_proposals() {
    for case in ["team-direct", "member", "personal-group"] {
        let g = if case == "personal-group" {
            personal().await
        } else {
            Group::new().await
        };
        if case == "team-direct" {
            direct(&g).await;
        }
        if case == "personal-group" {
            let mut chat = g
                .store
                .get(Table::Conversations, &g.cid)
                .await
                .unwrap()
                .unwrap();
            chat["isGroup"] = json!(true);
            chat["agentIds"] = json!([g.ids[0], g.ids[1]]);
            g.store.put(Table::Conversations, &chat).await.unwrap();
        }
        let model = Model::new(Arc::new(|body| {
            Box::pin(async move {
                assert!(!advertised(&body));
                if has_tool_result(&body) {
                    finish("No private endpoint card from this scope.")
                } else {
                    suggest(URL)
                }
            })
        }))
        .await;
        g.configure(&model).await;
        g.send(&format!("Connect {URL}"), "followUp", case == "member")
            .await;
        let messages = g.done().await;
        assert!(cards(&messages).is_empty());
        assert!(messages.iter().any(|m| m["content"]
            == "No private endpoint card from this scope."
            && m["status"] == "done"));
        g.close().await;
    }
}

#[tokio::test]
async fn quoted_question_answer_and_execution_prompt_cannot_supply_an_endpoint() {
    for marker in [
        "questionAnswer",
        "memoryImport",
        "voiceCallId",
        "executionPrompt",
    ] {
        let g = personal().await;
        let entered = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let model = Model::new(Arc::new({
            let entered = entered.clone();
            let release = release.clone();
            move |body| {
                let entered = entered.clone();
                let release = release.clone();
                Box::pin(async move {
                    if has_tool_result(&body) {
                        finish("Changed source was refused.")
                    } else {
                        entered.add_permits(1);
                        agent_delegation_support::wait_gate(&release).await;
                        suggest(URL)
                    }
                })
            }
        }))
        .await;
        g.configure(&model).await;
        let input = g.send(&format!("Connect {URL}"), "followUp", false).await;
        agent_delegation_support::wait_gate(&entered).await;
        let mut input = g
            .store
            .get(Table::Messages, input["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        if marker == "executionPrompt" {
            input[marker] = json!("Synthetic rewritten prompt");
        } else {
            input["metadata"][marker] = json!({"synthetic":true});
        }
        g.store.put(Table::Messages, &input).await.unwrap();
        release.add_permits(1);
        let messages = g.done().await;
        assert!(cards(&messages).is_empty(), "{marker}: {messages:?}");
        g.close().await;
    }
}

#[tokio::test]
async fn explicit_review_failure_stays_error_and_exact_canonical_duplicates_are_rejected() {
    let g = personal().await;
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            if has_tool_result(&body) {
                finish("Review the pending endpoint.")
            } else {
                suggest(URL)
            }
        })
    }))
    .await;
    g.configure(&model).await;
    g.send(&format!("Connect {URL}"), "followUp", false).await;
    let messages = g.done().await;
    let card = cards(&messages)[0].clone();
    // Reserved .invalid fails in the real MCP worker after explicit review, without public traffic.
    let reviewed =
        g.f.request(
            "POST",
            &g.f.path("/apps"),
            Some(json!({"name":"Synthetic custom","url":URL,"authType":"none","shared":true})),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(reviewed.0, 200, "{}", reviewed.1);
    assert_eq!(reviewed.1["status"], "error");
    assert!(reviewed.1["error"].is_string());
    assert_eq!(
        g.store
            .get(Table::Messages, card["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap(),
        card
    );
    let duplicate=g.f.request("POST",&g.f.path("/apps"),Some(json!({"name":"A distinct name","url":"https://MCP.SYNTHETIC.INVALID:443/custom/","authType":"oauth","shared":true})),false,Some(&g.f.owner)).await;
    assert_eq!(duplicate.0, 409);
    assert_eq!(duplicate.1["code"], "APP_CONNECTION_EXISTS");
    let distinct=g.f.request("POST",&g.f.path("/apps"),Some(json!({"name":"Different exact path","url":"https://mcp.synthetic.invalid/custom","authType":"oauth","shared":true})),false,Some(&g.f.owner)).await;
    assert_eq!(distinct.0, 200);
    assert_eq!(distinct.1["status"], "needs_auth");
    g.close().await;
}

#[tokio::test]
async fn a_shared_bot_cannot_advertise_or_force_private_endpoint_proposals() {
    let s = shared_bots_support::Shared::new().await;
    let joined = s.add().await;
    let model = Model::new(Arc::new(|body| {
        Box::pin(async move {
            assert!(!advertised(&body));
            if has_tool_result(&body) {
                finish("Shared source refused.")
            } else {
                suggest(URL)
            }
        })
    }))
    .await;
    let prefix = format!("/api/workspaces/{}", s.personal);
    assert_eq!(
        s.f.request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(model.config()),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        200
    );
    assert_eq!(s.f.request("POST",&format!("{prefix}/conversations/{}/messages",joined["conversationId"].as_str().unwrap()),Some(json!({"content":format!("Connect {URL}"),"clientId":"shared-custom","agentId":joined["agentId"]})),true,Some(&s.f.member)).await.0,202);
    tokio::time::timeout(std::time::Duration::from_secs(35), async {
        while !s.f.state.agent_runs.requests(&s.personal).await.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let store =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let messages = store.list(Table::Messages).await.unwrap();
    assert!(cards(&messages).is_empty());
    assert!(
        messages
            .iter()
            .any(|m| m["content"] == "Shared source refused." && m["status"] == "done")
    );
    s.close().await;
}
