mod shared_bots_support;
use openbot_backend::workspace::Table;
use serde_json::json;
use shared_bots_support::*;

#[tokio::test]
async fn shared_team_reuse_reviews_live_source_then_commits_existing_private_alias_without_fork() {
    let s = Shared::new().await;
    let receipt = s.add().await;
    let target =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let local = target
        .list(Table::Agents)
        .await
        .unwrap()
        .into_iter()
        .find(|a| a.get("sharedBot").is_none())
        .unwrap();
    let original_cached = target
        .get(Table::Agents, receipt["agentId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap()["description"]
        .clone();
    let draft = json!({"title":"Shared collaboration","summary":"Use an existing shared colleague","leadKey":"shared","members":[{"key":"shared","kind":"reuse","agentId":receipt["agentId"],"assignment":"Source expertise"},{"key":"local","kind":"reuse","agentId":local["id"],"assignment":"Personal follow-up"}]});
    let plan = json!({"id":id(),"requestId":id(),"revision":id(),"goal":"Synthetic coordination","status":"ready","draft":draft,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"});
    sqlx::query("INSERT INTO bot_team_plans(id,request_id,data) VALUES(?,?,?)")
        .bind(plan["id"].as_str())
        .bind(plan["requestId"].as_str())
        .bind(json!({"plan":plan,"catalog":{}}).to_string())
        .execute(&target.pool)
        .await
        .unwrap();
    let path = format!(
        "/api/workspaces/{}/bot-team-plans/{}",
        s.personal,
        plan["id"].as_str().unwrap()
    );
    let review_body = json!({"expectedRevision":plan["revision"],"draft":draft});
    let (status, review) =
        s.f.request(
            "POST",
            &format!("{path}/review-bots"),
            Some(review_body.clone()),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(status, 200, "{review}");
    let displayed = review["members"][0]["profile"].clone();
    assert_eq!(displayed["sharedBot"]["status"], "active");
    assert_eq!(displayed["sharedBot"]["shareId"], s.share["id"]);
    let mut source = s
        .source
        .get(Table::Agents, &s.agent)
        .await
        .unwrap()
        .unwrap();
    source["description"] = json!("New source responsibilities");
    source["configRevision"] = json!(id());
    s.source.put(Table::Agents, &source).await.unwrap();
    let stale = json!({"requestId":id(),"expectedRevision":plan["revision"],"draft":draft,"reviewToken":review["reviewToken"]});
    assert_eq!(
        s.f.request(
            "POST",
            &format!("{path}/refresh-bots"),
            Some(stale),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        409
    );
    let (_, review) =
        s.f.request(
            "POST",
            &format!("{path}/review-bots"),
            Some(review_body),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(
        review["members"][0]["profile"]["description"],
        "New source responsibilities"
    );
    let (status,refreshed)=s.f.request("POST",&format!("{path}/refresh-bots"),Some(json!({"requestId":id(),"expectedRevision":plan["revision"],"draft":draft,"reviewToken":review["reviewToken"]})),true,Some(&s.f.member)).await;
    assert_eq!(status, 200, "{refreshed}");
    let (status,committed)=s.f.request("POST",&format!("{path}/commit"),Some(json!({"requestId":id(),"expectedRevision":refreshed["plan"]["revision"],"draft":draft})),true,Some(&s.f.member)).await;
    assert_eq!(status, 200, "{committed}");
    assert_eq!(committed["result"]["createdAgentIds"], json!([]));
    assert_eq!(committed["result"]["leadAgentId"], receipt["agentId"]);
    let group = target
        .get(
            Table::Conversations,
            committed["result"]["conversationId"].as_str().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(group["agentIds"], json!([receipt["agentId"], local["id"]]));
    assert_eq!(target.list(Table::Agents).await.unwrap().len(), 2);
    assert_eq!(
        target
            .get(Table::Agents, receipt["agentId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["description"],
        original_cached,
        "live profile is never cached into target store"
    );
    s.close().await;
}
