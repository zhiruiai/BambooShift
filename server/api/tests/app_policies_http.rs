mod agent_delegation_support;
mod app_policy_support;
mod apps_support;
mod workspace_support;
use app_policy_support::*;
use openbot_backend::workspace::Table;
use serde_json::json;

#[tokio::test]
async fn owner_explicit_exact_scope_is_required_and_unknown_or_writing_tools_are_never_candidates()
{
    let (g, s, c, r) = setup().await;
    let request = body(&g, &c, &r, "read_notes").await;
    assert_eq!(
        g.f.request("GET", &path(&g, &c), None, true, Some(&g.f.member))
            .await
            .0,
        403
    );
    for (member, expected) in [
        (true, Some(g.f.member.as_str())),
        (false, Some(g.f.member.as_str())),
        (false, None),
    ] {
        assert_eq!(
            g.f.request(
                "POST",
                &path(&g, &c),
                Some(request.clone()),
                member,
                expected
            )
            .await
            .0,
            403
        );
    }
    for tool in ["write_note", "unclassified", "contradictory"] {
        let b = body(&g, &c, &r, tool).await;
        assert_eq!(
            g.f.request("POST", &path(&g, &c), Some(b), false, Some(&g.f.owner))
                .await
                .0,
            409
        );
    }
    let mut unconfirmed = request.clone();
    unconfirmed["confirmReadOnly"] = json!(false);
    assert_eq!(
        g.f.request(
            "POST",
            &path(&g, &c),
            Some(unconfirmed),
            false,
            Some(&g.f.owner)
        )
        .await
        .0,
        400
    );
    let first =
        g.f.request(
            "POST",
            &path(&g, &c),
            Some(request.clone()),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(first.0, 200, "{}", first.1);
    assert_eq!(first.1["issuerUserId"], g.f.owner);
    let second =
        g.f.request(
            "POST",
            &path(&g, &c),
            Some(request),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(second.1, first.1);
    assert!(second.1.get("sourceRevision").is_none());
    drop(s);
    g.close().await;
}
#[tokio::test]
async fn every_configuration_write_invalidates_permanently_but_scheduler_timestamps_do_not() {
    let (g, s, c, r) = setup().await;
    let policy = grant(&g, &c, &r).await;
    let id = r["id"].as_str().unwrap();
    let mut current = g.store.get(Table::Routines, id).await.unwrap().unwrap();
    current["lastRunAt"] = json!("2026-01-01T00:00:00Z");
    g.store.put(Table::Routines, &current).await.unwrap();
    assert_eq!(
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .1[0]["status"],
        "active"
    );
    let route = g.f.path(&format!("/routines/{id}"));
    assert_eq!(
        g.f.request(
            "PATCH",
            &route,
            Some(json!({"prompt":"Different confirmed work"})),
            false,
            Some(&g.f.owner)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        g.f.request(
            "PATCH",
            &route,
            Some(json!({"prompt":r["prompt"]})),
            false,
            Some(&g.f.owner)
        )
        .await
        .0,
        200
    );
    let listing =
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .1;
    assert_eq!(listing[0]["id"], policy["id"]);
    assert_eq!(listing[0]["status"], "invalidated");
    let next = grant(&g, &c, &r).await;
    assert_eq!(
        g.f.request("DELETE", &route, Some(json!({})), false, Some(&g.f.owner))
            .await
            .0,
        200
    );
    assert!(
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .1
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["status"] == "invalidated")
    );
    assert_ne!(next["id"], policy["id"]);
    drop(s);
    g.close().await;
}
#[tokio::test]
async fn a_cancelled_unknown_request_cannot_arrive_late_and_revoke_is_durable_idempotent() {
    let (g, s, c, r) = setup().await;
    let request = body(&g, &c, &r, "read_notes").await;
    let revoke = format!(
        "{}/{}/revoke",
        path(&g, &c),
        request["requestId"].as_str().unwrap()
    );
    for _ in 0..2 {
        let response =
            g.f.request("POST", &revoke, Some(json!({})), false, Some(&g.f.owner))
                .await;
        assert_eq!(response.0, 200);
        assert_eq!(response.1["status"], "not_created");
    }
    let late =
        g.f.request(
            "POST",
            &path(&g, &c),
            Some(request),
            false,
            Some(&g.f.owner),
        )
        .await;
    assert_eq!(late.0, 409);
    assert_eq!(late.1["code"], "APP_POLICY_CLOSED");
    let policy = grant(&g, &c, &r).await;
    let revoke = format!("{}/{}/revoke", path(&g, &c), policy["id"].as_str().unwrap());
    assert_eq!(
        g.f.request("POST", &revoke, Some(json!({})), false, Some(&g.f.owner))
            .await
            .1["status"],
        "revoked"
    );
    drop(s);
    g.close().await;
}
