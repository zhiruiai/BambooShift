mod workspace_support;

use serde_json::{Value, json};
use workspace_support::Fixture;

#[tokio::test]
async fn software_team_is_reviewed_then_committed_with_its_lead_and_phase_handoffs() {
    for (language, title) in [
        ("en", "Software Product Team"),
        ("zh-CN", "软件产品交付团队"),
    ] {
        let f = Fixture::new().await;
        let before = f.bootstrap().await;
        let (status, plan) = f
            .request(
                "POST",
                &f.path("/bot-team-plans"),
                Some(json!({
                    "requestId":uuid::Uuid::new_v4().to_string(),
                    "goal":"Build a synthetic inventory product with explicit acceptance",
                    "template":{"id":"software-product","language":language}
                })),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 202, "{plan}");
        assert_eq!(plan["status"], "ready");
        assert_eq!(plan["draft"]["title"], title);
        assert_eq!(plan["draft"]["leadKey"], "lead");
        let members = plan["draft"]["members"].as_array().unwrap();
        assert_eq!(
            members
                .iter()
                .map(|m| m["key"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["lead", "product", "backend", "frontend", "qa", "release"]
        );
        let previewed = f.bootstrap().await;
        for key in ["agents", "conversations", "messages", "routines", "skills"] {
            assert_eq!(previewed[key], before[key], "preview must not start work");
        }
        let request = json!({
            "requestId":uuid::Uuid::new_v4().to_string(),
            "expectedRevision":plan["revision"],
            "draft":plan["draft"]
        });
        let path = f.path(&format!(
            "/bot-team-plans/{}/commit",
            plan["id"].as_str().unwrap()
        ));
        let (status, committed) = f
            .request("POST", &path, Some(request.clone()), false, Some(&f.owner))
            .await;
        assert_eq!(status, 200, "{committed}");
        assert_eq!(
            committed["result"]["createdAgentIds"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
        let (_, replay) = f
            .request("POST", &path, Some(request), false, Some(&f.owner))
            .await;
        assert_eq!(replay, committed);
        let after = f.bootstrap().await;
        let group = after["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == committed["result"]["conversationId"])
            .unwrap();
        let ids = committed["result"]["memberAgentIds"].as_array().unwrap();
        assert_eq!(group["agentIds"], json!(ids));
        assert_eq!(group["teamBrief"]["leadAgentId"], ids[0]);
        assert_eq!(group["teamBrief"]["summary"], plan["draft"]["summary"]);
        let assignments: Vec<Value> = members
            .iter()
            .zip(ids)
            .map(|(member, id)| {
                let bot = after["agents"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|bot| bot["id"] == *id)
                    .unwrap();
                assert_eq!(bot["instructions"], member["instructions"]);
                json!({"agentId":id,"assignment":member["assignment"]})
            })
            .collect();
        assert_eq!(group["teamBrief"]["assignments"], json!(assignments));
        assert_eq!(after["messages"], before["messages"]);
        assert_eq!(after["routines"], before["routines"]);
        f.close().await;
    }
}
