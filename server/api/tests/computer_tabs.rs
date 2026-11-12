mod computer_support;
mod workspace_support;
use computer_support::*;
use openbot_backend::computer::validation;
use serde_json::json;
use std::sync::atomic::Ordering;
use workspace_support::Fixture;

#[test]
fn only_listing_is_readonly_and_tab_targets_are_canonical_ids() {
    assert!(validation::readonly("browser_tabs"));
    for kind in ["browser_select_tab", "browser_close_tab"] {
        assert!(!validation::readonly(kind));
        for tab in [
            json!(null),
            json!(""),
            json!("t1"),
            json!("../page"),
            json!(42),
        ] {
            assert!(validation::action(&json!({"type":kind,"tabId":tab}), false).is_err());
        }
        let tab = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            validation::action(
                &json!({"type":kind,"tabId":tab,"title":"untrusted","status":"done"}),
                false
            )
            .unwrap(),
            json!({"type":kind,"tabId":tab})
        );
    }
}

#[tokio::test]
async fn tab_listing_executes_but_switching_waits_for_the_original_requester() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    s.worker.browser_tabs_capable.store(true, Ordering::SeqCst);
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    prepared(&f, agent).await;
    let path = f.path(&format!("/computer/bots/{agent}/actions"));
    let (status, listing) = f
        .request(
            "POST",
            &path,
            Some(json!({"type":"browser_tabs"})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200, "{listing}");
    assert_eq!(listing["status"], "done", "{listing}");
    let tab = uuid::Uuid::new_v4().to_string();
    let (status, action) = f
        .request(
            "POST",
            &path,
            Some(json!({"type":"browser_select_tab","tabId":tab})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(status, 200, "{action}");
    assert_eq!(action["status"], "pending");
    assert!(
        !s.worker
            .calls
            .lock()
            .await
            .iter()
            .any(|(path, body)| path.ends_with("/execute") && body["type"] == "browser_select_tab")
    );
    let decision = format!("{}/{}/approve", path, action["id"].as_str().unwrap());
    assert_eq!(
        f.request("POST", &decision, Some(json!({})), false, Some(&f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        f.request("POST", &decision, Some(json!({})), true, Some(&f.member))
            .await
            .0,
        200
    );
    let done = settled(&f, action["id"].as_str().unwrap()).await;
    assert_eq!(done["status"], "done", "{done}");
    assert!(
        s.worker
            .calls
            .lock()
            .await
            .iter()
            .any(|(path, body)| path.ends_with("/execute")
                && body == &json!({"type":"browser_select_tab","tabId":tab}))
    );
    let (_, close) = f
        .request(
            "POST",
            &path,
            Some(json!({"type":"browser_close_tab","tabId":tab})),
            true,
            Some(&f.member),
        )
        .await;
    assert_eq!(close["status"], "pending");
    let reject = format!("{}/{}/reject", path, close["id"].as_str().unwrap());
    assert_eq!(
        f.request("POST", &reject, Some(json!({})), true, Some(&f.member))
            .await
            .0,
        200
    );
    assert!(
        !s.worker
            .calls
            .lock()
            .await
            .iter()
            .any(|(path, body)| path.ends_with("/execute") && body["type"] == "browser_close_tab")
    );
}

#[tokio::test]
async fn workers_without_tab_capability_fail_before_an_approval_is_created() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    prepared(&f, agent).await;
    let path = f.path(&format!("/computer/bots/{agent}/actions"));
    for kind in ["browser_tabs", "browser_select_tab", "browser_close_tab"] {
        let (status, reply) = f
            .request(
                "POST",
                &path,
                Some(json!({"type":kind,"tabId":uuid::Uuid::new_v4().to_string()})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 409, "{reply}");
        assert!(reply.to_string().contains("升级执行器"), "{reply}");
    }
    assert!(
        !s.worker
            .calls
            .lock()
            .await
            .iter()
            .any(|(path, _)| path.ends_with("/execute"))
    );
}
