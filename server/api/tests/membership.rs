mod common;
use common::{Fixture, request};
use serde_json::json;

#[tokio::test]
async fn invitations_are_single_use_and_members_cannot_manage_others() {
    let f = Fixture::new().await;
    let owner = f.register("owner@example.test", true).await;
    let a = f.register("a@example.test", false).await;
    let b = f.register("b@example.test", false).await;
    let wid = owner.value["workspaceId"].as_str().unwrap();
    let team = format!("/api/account/workspaces/{wid}");
    assert_eq!(
        f.request("GET", &format!("{team}/team"), &a.cookie(), None)
            .await
            .status,
        403
    );
    let invite = f
        .request(
            "POST",
            &format!("{team}/invitations"),
            &owner.cookie(),
            None,
        )
        .await;
    assert_eq!(invite.status, 201);
    let token = invite.value["token"].as_str().unwrap();
    let preview = f
        .request("GET", &format!("/api/invitations/{token}"), "", None)
        .await;
    assert_eq!(preview.value["available"], true);
    assert!(preview.value.get("email").is_none());
    let url = format!("/api/invitations/{token}/accept");
    let a_cookie = a.cookie();
    let b_cookie = b.cookie();
    let (one, two) = tokio::join!(
        f.request("POST", &url, &a_cookie, None),
        f.request("POST", &url, &b_cookie, None)
    );
    let mut codes = vec![one.status, two.status];
    codes.sort();
    assert_eq!(codes, vec![200, 409]);
    let member = if one.status == 200 { &a } else { &b };
    let details = f
        .request("GET", &format!("{team}/team"), &member.cookie(), None)
        .await;
    assert_eq!(details.value["members"].as_array().unwrap().len(), 2);
    assert_eq!(details.value["invitations"], json!([]));
    assert_eq!(
        f.request(
            "POST",
            &format!("{team}/invitations"),
            &member.cookie(),
            None
        )
        .await
        .status,
        403
    );
    assert_eq!(
        f.request(
            "PATCH",
            &team,
            &member.cookie(),
            Some(json!({"name":"not allowed"}))
        )
        .await
        .status,
        403
    );
    let owner_id = owner.value["user"]["id"].as_str().unwrap();
    assert_eq!(
        f.request(
            "DELETE",
            &format!("{team}/members/{owner_id}"),
            &member.cookie(),
            None
        )
        .await
        .status,
        403
    );
    assert_eq!(
        f.request(
            "DELETE",
            &format!("{team}/members/{owner_id}"),
            &owner.cookie(),
            None
        )
        .await
        .status,
        409
    );
    let member_id = member.value["user"]["id"].as_str().unwrap();
    assert_eq!(
        f.request(
            "DELETE",
            &format!("{team}/members/{member_id}"),
            &member.cookie(),
            None
        )
        .await
        .status,
        200
    );
    assert_eq!(
        f.request("GET", &format!("{team}/team"), &member.cookie(), None)
            .await
            .status,
        403
    );
    f.state.close().await;
}

#[tokio::test]
async fn revoked_expired_and_suspended_invites_cannot_add_members() {
    let f = Fixture::new().await;
    let owner = f.register("owner@example.test", true).await;
    let member = f.register("member@example.test", false).await;
    let wid = owner.value["workspaceId"].as_str().unwrap();
    let base = format!("/api/account/workspaces/{wid}/invitations");
    let db = f.database().await;
    for reason in ["revoked", "expired", "suspended"] {
        let invite = f.request("POST", &base, &owner.cookie(), None).await;
        assert_eq!(invite.status, 201);
        let id = invite.value["invitation"]["id"].as_str().unwrap();
        let token = invite.value["token"].as_str().unwrap();
        match reason {
            "revoked" => {
                assert_eq!(
                    f.request("DELETE", &format!("{base}/{id}"), &owner.cookie(), None)
                        .await
                        .status,
                    200
                );
            }
            "expired" => {
                sqlx::query("UPDATE invitations SET expires_at=0 WHERE id=?")
                    .bind(id)
                    .execute(&db)
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query("UPDATE workspaces SET status='suspended' WHERE id=?")
                    .bind(wid)
                    .execute(&db)
                    .await
                    .unwrap();
            }
        }
        assert_eq!(
            f.request("GET", &format!("/api/invitations/{token}"), "", None)
                .await
                .value["available"],
            false
        );
        assert_eq!(
            f.request(
                "POST",
                &format!("/api/invitations/{token}/accept"),
                &member.cookie(),
                None
            )
            .await
            .status,
            409
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memberships WHERE workspace_id=?")
            .bind(wid)
            .fetch_one(&db)
            .await
            .unwrap(),
        1
    );
    db.close().await;
    f.state.close().await;
}

#[tokio::test]
async fn stale_actor_header_cannot_rename_a_shared_team() {
    let f = Fixture::new().await;
    let a = f.register("a@example.test", true).await;
    let b = f.register("b@example.test", false).await;
    let a_id = a.value["user"]["id"].as_str().unwrap();
    let wid = a.value["workspaceId"].as_str().unwrap();
    let denied = request(
        &f.app,
        "POST",
        "/api/account/workspaces",
        &b.cookie(),
        Some(json!({"name":"wrong actor"})),
        &[("x-openbot-expected-user", a_id)],
    )
    .await;
    assert_eq!(denied.status, 403);
    assert_eq!(
        f.request(
            "PATCH",
            &format!("/api/account/workspaces/{wid}"),
            &a.cookie(),
            Some(json!({"name":"updated"}))
        )
        .await
        .value["name"],
        "updated"
    );
    f.state.close().await;
}
