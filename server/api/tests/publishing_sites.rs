mod workspace_support;

use serde_json::json;
use workspace_support::Fixture;

#[tokio::test]
async fn publishing_addresses_persist_for_members_and_are_isolated_by_workspace() {
    let f = Fixture::new().await;
    let path = f.path("/publishing-sites");
    let owner = Some(f.owner.as_str());
    let member = Some(f.member.as_str());
    let site = json!({"name":"Engineering journal","url":"https://journal.example.com/editor"});
    let (status, defaults) = f.request("GET", &path, None, true, member).await;
    assert_eq!(status, 200);
    let presets = defaults.as_array().unwrap();
    assert!(
        presets
            .iter()
            .any(|target| target["name"] == "WordPress.com")
    );
    assert_eq!(
        f.request("POST", &path, Some(site.clone()), true, member)
            .await
            .0,
        403
    );
    for _ in 0..2 {
        let (status, result) = f
            .request("POST", &path, Some(site.clone()), false, owner)
            .await;
        assert_eq!(status, 200, "{result}");
        assert_eq!(result.as_array().unwrap().len(), presets.len() + 1);
    }
    let (_, result) = f.request("GET", &path, None, true, member).await;
    assert!(result.as_array().unwrap().contains(&site));
    let (_, foreign) = f
        .request(
            "GET",
            &format!("/api/workspaces/{}/publishing-sites", f.foreign),
            None,
            true,
            member,
        )
        .await;
    assert_eq!(foreign, defaults);
    for target in [
        json!({"name":"Medium","url":"https://other.example.com/write"}),
        json!({"name":"Local","url":"https://127.0.0.1/write"}),
        json!({"name":"LAN","url":"https://intranet.local/write"}),
        json!({"name":"Credential","url":"https://journal.example.com/write?token=private"}),
        json!({"name":"Password","url":"https://user:pass@journal.example.com/write"}),
        json!({"name":"HTTP","url":"http://journal.example.com/write"}),
        json!({"name":"Other","url":"https://journal.example.com/write","token":"private"}),
    ] {
        assert_eq!(
            f.request("POST", &path, Some(target), false, owner).await.0,
            400
        );
    }
    assert_eq!(
        f.request("DELETE", &path, Some(site.clone()), true, member)
            .await
            .0,
        403
    );
    for _ in 0..2 {
        let (status, result) = f
            .request("DELETE", &path, Some(site.clone()), false, owner)
            .await;
        assert_eq!(status, 200);
        assert_eq!(result, defaults);
    }
    f.close().await;
}
