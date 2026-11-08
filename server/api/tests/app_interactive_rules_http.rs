mod workspace_support;

use axum::http::HeaderMap;
use openbot_backend::{
    apps::{self, actions::ActionContext, interactive_policy::Candidate},
    workspace::{Table, WorkspaceStore, access},
};
use serde_json::{Value, json};
use uuid::Uuid;
use workspace_support::Fixture;

async fn personal(fixture: &Fixture) -> std::sync::Arc<WorkspaceStore> {
    sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
        .bind(&fixture.workspace)
        .execute(&fixture.db)
        .await
        .unwrap();
    fixture.bootstrap().await;
    let actor = actor(fixture).await;
    actor.store(&fixture.state).await.unwrap()
}

async fn actor(fixture: &Fixture) -> openbot_backend::workspace::WorkspaceAccess {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        format!("openbot_account={}", fixture.owner_token)
            .parse()
            .unwrap(),
    );
    headers.insert("x-openbot-expected-user", fixture.owner.parse().unwrap());
    access::require(&fixture.state, &headers, &fixture.workspace, true, true)
        .await
        .unwrap()
}

async fn rules(fixture: &Fixture, member: bool) -> (u16, Value) {
    fixture
        .request(
            "GET",
            &fixture.path("/apps/approval-rules"),
            None,
            member,
            Some(if member {
                &fixture.member
            } else {
                &fixture.owner
            }),
        )
        .await
}

#[tokio::test]
async fn current_personal_owner_can_read_and_revoke_only_their_rules() {
    let fixture = Fixture::new().await;
    assert_eq!(rules(&fixture, false).await, (200, json!({"rules":[]})));
    let store = personal(&fixture).await;
    let own = Uuid::new_v4().to_string();
    let other = Uuid::new_v4().to_string();
    for (issuer, id) in [(&fixture.owner, &own), (&fixture.member, &other)] {
        sqlx::query("INSERT INTO app_interactive_rules VALUES(?,?,'digest','app','chat','bot','active',?)")
            .bind(id)
            .bind(issuer)
            .bind(json!({"id":id,"input":{"method":"get","owner":"octocat","repo":"demo","issue_number":7}}).to_string())
            .execute(&store.pool).await.unwrap();
    }
    let (status, result) = rules(&fixture, false).await;
    assert_eq!(status, 200);
    assert_eq!(result["rules"].as_array().unwrap().len(), 1);
    assert_eq!(result["rules"][0]["id"], own);
    assert_eq!(rules(&fixture, true).await, (200, json!({"rules":[]})));
    for (id, member, expected_status) in [
        (&own, true, 403),
        (&other, false, 404),
        (&own, false, 200),
        (&own, false, 200),
    ] {
        let result = fixture
            .request(
                "DELETE",
                &fixture.path(&format!("/apps/approval-rules/{id}")),
                None,
                member,
                Some(if member {
                    &fixture.member
                } else {
                    &fixture.owner
                }),
            )
            .await;
        assert_eq!(result.0, expected_status, "{}", result.1);
        if expected_status == 200 {
            assert_eq!(result.1, json!({"ok":true}));
        }
    }
    assert_eq!(rules(&fixture, false).await, (200, json!({"rules":[]})));
    assert_eq!(
        fixture
            .request(
                "GET",
                &fixture.path("/apps/approval-rules"),
                None,
                false,
                None
            )
            .await
            .0,
        403
    );
    fixture.close().await;
}

#[tokio::test]
async fn tool_shape_endpoint_and_bot_revision_are_checked_before_a_rule_is_saved() {
    let fixture = Fixture::new().await;
    let store = personal(&fixture).await;
    let actor = actor(&fixture).await;
    let agent = store.list(Table::Agents).await.unwrap().remove(0);
    let agent_id = agent["id"].as_str().unwrap();
    let chat = store.list(Table::Conversations).await.unwrap().remove(0);
    let chat_id = chat["id"].as_str().unwrap();
    let input = json!({"method":"get","owner":"octocat","repo":"demo","issue_number":7});
    let tool = json!({"name":"issue_read","description":"Read issue","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}});

    for mode in [
        "unofficial",
        "extra",
        "wrong_method",
        "no_annotation",
        "stale_bot",
        "limit",
    ] {
        let app_id = Uuid::new_v4().to_string();
        let revision = Uuid::new_v4().to_string();
        let mut tool = tool.clone();
        if mode == "no_annotation" {
            tool["annotations"] = json!({});
        }
        let url = if mode == "unofficial" {
            "https://example.test/mcp/readonly"
        } else {
            "https://api.githubcopilot.com/mcp/readonly"
        };
        let connection = json!({"id":app_id,"name":"GitHub","url":url,"revision":revision,
            "authType":"bearer","status":"connected","tools":[tool]});
        sqlx::query("INSERT INTO app_connections VALUES(?,?)")
            .bind(&app_id)
            .bind(connection.to_string())
            .execute(&store.pool)
            .await
            .unwrap();
        let message_id = Uuid::new_v4().to_string();
        let run_id = Uuid::new_v4().to_string();
        store
            .put(
                Table::Messages,
                &json!({"id":message_id,"conversationId":chat_id,
            "role":"user","kind":"text","content":"Check this issue.","userId":actor.user_id,
            "delivery":{"state":"delivered","agentId":agent_id,"runId":run_id},
            "appContext":{"connectionId":app_id,"revision":revision}}),
            )
            .await
            .unwrap();
        let candidate = Candidate {
            actor: actor.clone(),
            conversation_id: chat_id.into(),
            agent_id: agent_id.into(),
            requester_message_id: message_id.clone(),
            run_id: run_id.clone(),
            connection_id: app_id.clone(),
            connection_revision: revision,
        };
        let context = ActionContext {
            conversation_id: chat_id.into(),
            thread_root_id: None,
            agent_id: agent_id.into(),
            run_id,
            source: None,
            requester: Some(json!({"userId":actor.user_id,"messageId":message_id})),
        };
        let mut arguments = input.clone();
        if mode == "extra" {
            arguments["page"] = json!(1);
        }
        if mode == "wrong_method" {
            arguments["method"] = json!("get_comments");
        }
        let prepared = apps::connections::prepare_call(&store, &app_id, "issue_read", &arguments)
            .await
            .unwrap();
        let action = apps::actions::request_with_candidate(
            &fixture.state,
            store.clone(),
            store.clone(),
            context,
            prepared,
            apps::user_authority(&fixture.state, &actor),
            Some(candidate),
        )
        .await
        .unwrap();
        assert_eq!(
            action["interactiveApproval"]["eligible"] == true,
            matches!(mode, "stale_bot" | "limit"),
            "{mode}"
        );
        if mode == "stale_bot" {
            let mut updated = agent.clone();
            updated["configRevision"] = json!(Uuid::new_v4().to_string());
            store.put(Table::Agents, &updated).await.unwrap();
        }
        if mode == "limit" {
            for n in 0..20 {
                sqlx::query("INSERT INTO app_interactive_rules VALUES(?,?,?,?,?,?,'active','{}')")
                    .bind(Uuid::new_v4().to_string())
                    .bind(&fixture.owner)
                    .bind(n.to_string())
                    .bind(&app_id)
                    .bind(chat_id)
                    .bind(agent_id)
                    .execute(&store.pool)
                    .await
                    .unwrap();
            }
        }
        let decision = fixture.path(&format!(
            "/app-actions/{}/decision",
            action["id"].as_str().unwrap()
        ));
        let (status, value) = fixture
            .request(
                "POST",
                &decision,
                Some(json!({"decision":"always_allow"})),
                false,
                Some(&fixture.owner),
            )
            .await;
        assert_eq!(status, 409, "{mode}: {value}");
        assert_eq!(
            value["code"],
            if mode == "limit" {
                "APP_APPROVAL_RULE_LIMIT"
            } else {
                "APP_APPROVAL_RULE_CHANGED"
            },
            "{mode}"
        );
        let denied = fixture
            .request(
                "POST",
                &decision,
                Some(json!({"approve":false})),
                false,
                Some(&fixture.owner),
            )
            .await;
        assert_eq!(denied.1["status"], "rejected", "{}", denied.1);
        if mode == "limit" {
            sqlx::query("UPDATE app_connections SET data=json_set(data,'$.revision',?) WHERE id=?")
                .bind(Uuid::new_v4().to_string())
                .bind(&app_id)
                .execute(&store.pool)
                .await
                .unwrap();
            let invalidated: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_interactive_rules WHERE connection_id=? AND status='invalidated'")
                .bind(&app_id).fetch_one(&store.pool).await.unwrap();
            assert_eq!(invalidated, 20);
        }
    }
    assert_eq!(rules(&fixture, false).await, (200, json!({"rules":[]})));
    fixture.close().await;
}
