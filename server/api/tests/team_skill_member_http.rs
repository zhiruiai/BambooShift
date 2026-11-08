mod workspace_support;

use serde_json::{Value, json};
use workspace_support::Fixture;

struct Case {
    f: Fixture,
    personal: String,
    bot: Value,
}

impl Case {
    async fn new() -> Self {
        let f = Fixture::new().await;
        let personal = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO workspaces VALUES(?,'Private skill source','personal','active',?,1)",
        )
        .bind(&personal)
        .bind(&personal)
        .execute(&f.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',1)")
            .bind(&personal)
            .bind(&f.member)
            .execute(&f.db)
            .await
            .unwrap();
        let (status, bot) = f
            .request(
                "POST",
                &format!("/api/workspaces/{personal}/agents"),
                Some(json!({"name":"Confidential source Bot"})),
                true,
                Some(&f.member),
            )
            .await;
        assert_eq!(status, 201, "{bot}");
        Self { f, personal, bot }
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        member: bool,
    ) -> (u16, Value) {
        self.f
            .request(
                method,
                path,
                body,
                member,
                Some(if member {
                    &self.f.member
                } else {
                    &self.f.owner
                }),
            )
            .await
    }

    fn personal(&self, suffix: &str) -> String {
        format!("/api/workspaces/{}{suffix}", self.personal)
    }

    fn publish(&self, skill: &Value) -> String {
        self.personal(&format!(
            "/private-skills/{}/team-publications/{}",
            skill["id"].as_str().unwrap(),
            self.f.workspace
        ))
    }

    fn targets(&self, skill: &Value) -> String {
        self.personal(&format!(
            "/private-skills/{}/team-publication-targets",
            skill["id"].as_str().unwrap()
        ))
    }

    fn link(&self, item: &Value) -> String {
        self.f.path(&format!(
            "/team-skills/{}/link/{}",
            item["id"].as_str().unwrap(),
            item["linkId"].as_str().unwrap()
        ))
    }

    fn policy(&self) -> String {
        self.f.path("/team-skills/publishing-policy")
    }

    async fn set_policy(&self, enabled: bool, revision: Value) -> Value {
        let (status, value) = self
            .call(
                "PUT",
                &self.policy(),
                Some(json!({
                    "memberPublishing":enabled,"expectedRevision":revision,
                })),
                false,
            )
            .await;
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["memberPublishing"], enabled);
        value["revision"].clone()
    }

    async fn skill(&self, content: &str, previous: Value) -> (Value, Value) {
        let (status, skill) = self.call("POST", &self.personal("/skills"), Some(json!({
            "agentId":self.bot["id"],"name":"Approved workflow","description":"Selected description",
            "content":content,
        })), true).await;
        assert_eq!(status, 201, "{skill}");
        let approve = self.personal(&format!(
            "/skills/{}/approve",
            skill["id"].as_str().unwrap()
        ));
        let (status, approved) = self
            .call(
                "POST",
                &approve,
                Some(json!({"expectedActiveId":previous})),
                true,
            )
            .await;
        assert_eq!(status, 200, "{approved}");
        let (status, shelf) = self
            .call("GET", &self.personal("/private-skills"), None, true)
            .await;
        assert_eq!(status, 200, "{shelf}");
        let proof = shelf["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == skill["id"])
            .unwrap();
        (approved, proof["revision"].clone())
    }

    async fn withdraw(&self, item: &Value, member: bool) -> (u16, Value) {
        let path = self.f.path(&format!(
            "/team-skills/{}/unpublish",
            item["id"].as_str().unwrap()
        ));
        self.call(
            "POST",
            &path,
            Some(json!({"expectedRevision":item["revision"]})),
            member,
        )
        .await
    }

    fn find_team(&self, targets: &Value) -> Option<Value> {
        targets["teams"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["workspaceId"] == self.f.workspace)
            .cloned()
    }

    async fn transfer_personal(&self, account: &str) {
        sqlx::query("UPDATE memberships SET user_id=? WHERE workspace_id=? AND role='owner'")
            .bind(account)
            .bind(&self.personal)
            .execute(&self.f.db)
            .await
            .unwrap();
    }
}

fn body(source: &Value, publication: &Value, policy: &Value) -> Value {
    json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedSourceRevision":source,
        "expectedPublicationRevision":publication,"expectedTeamPolicyRevision":policy})
}

#[tokio::test]
async fn member_policy_is_opt_in_revisioned_and_receipts_recover_without_republishing() {
    let c = Case::new().await;
    let (skill, proof) = c
        .skill("Approved synthetic instructions", Value::Null)
        .await;
    assert_eq!(
        c.call("GET", &c.policy(), None, false).await,
        (200, json!({"memberPublishing":false,"revision":"unset"}))
    );
    assert_eq!(c.call("GET", &c.policy(), None, true).await.0, 403);
    assert_eq!(
        c.call(
            "PUT",
            &c.policy(),
            Some(json!({"memberPublishing":true,"expectedRevision":"unset"})),
            true
        )
        .await
        .0,
        403
    );
    let (_, targets) = c.call("GET", &c.targets(&skill), None, true).await;
    assert!(c.find_team(&targets).is_none());
    let path = c.publish(&skill);
    let denied = c
        .call(
            "PUT",
            &path,
            Some(body(&proof, &Value::Null, &Value::Null)),
            true,
        )
        .await;
    assert_eq!(
        (denied.0, denied.1["code"].as_str()),
        (403, Some("TEAM_SKILL_MEMBER_PUBLISHING_DISABLED"))
    );

    let first = c.set_policy(true, json!("unset")).await;
    let (_, targets) = c.call("GET", &c.targets(&skill), None, true).await;
    assert_eq!(c.find_team(&targets).unwrap()["policyRevision"], first);
    assert_eq!(
        c.call(
            "PUT",
            &path,
            Some(body(&proof, &Value::Null, &Value::Null)),
            true
        )
        .await
        .1["code"],
        "TEAM_SKILL_POLICY_CHANGED"
    );
    let off = c.set_policy(false, first.clone()).await;
    let second = c.set_policy(true, off).await;
    assert_ne!(first, second);
    assert_eq!(
        c.call("PUT", &path, Some(body(&proof, &Value::Null, &first)), true)
            .await
            .1["code"],
        "TEAM_SKILL_POLICY_CHANGED"
    );
    assert_eq!(
        c.call(
            "PUT",
            &c.policy(),
            Some(json!({"memberPublishing":false,"expectedRevision":first})),
            false
        )
        .await
        .1["code"],
        "TEAM_SKILL_POLICY_CHANGED"
    );
    let attempt = body(&proof, &Value::Null, &second);
    let published = c.call("PUT", &path, Some(attempt.clone()), true).await;
    assert_eq!(published.0, 200, "{published:?}");
    let receipt = format!("{path}/{}", attempt["requestId"].as_str().unwrap());
    let receipt_item = &published.1["publication"];
    assert!(uuid::Uuid::parse_str(receipt_item["linkId"].as_str().unwrap()).is_ok());

    c.set_policy(false, second.clone()).await;
    assert_eq!(c.call("GET", &receipt, None, true).await, published);
    assert_eq!(c.call("PUT", &path, Some(attempt), true).await, published);
    assert_eq!(
        c.call(
            "PUT",
            &path,
            Some(body(&proof, &receipt_item["revision"], &second)),
            true
        )
        .await
        .1["code"],
        "TEAM_SKILL_MEMBER_PUBLISHING_DISABLED"
    );
    let link = c.link(receipt_item);
    let (status, published_content) = c.call("GET", &link, None, true).await;
    assert_eq!(status, 200, "{published_content}");
    assert_eq!(
        published_content["content"],
        "Approved synthetic instructions"
    );
    assert_eq!(published_content["canWithdraw"], true);
    assert_eq!(published_content["canModerate"], false);
    assert_eq!(
        published_content["source"],
        json!({"origin":"personal","version":1})
    );
    for private in [
        c.f.member.as_str(),
        c.personal.as_str(),
        "Confidential source Bot",
        "Private skill source",
        skill["id"].as_str().unwrap(),
        proof.as_str().unwrap(),
    ] {
        assert!(
            !published_content.to_string().contains(private),
            "{published_content}"
        );
    }
    assert_eq!(
        c.f.request("GET", &link, None, true, Some(&c.f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        c.f.with_cookie(
            "GET",
            &link,
            None,
            &format!("openbot_operator={}", c.f.operator_token),
            Some(&c.f.owner)
        )
        .await
        .0,
        401
    );
    assert_eq!(
        c.call(
            "GET",
            &link.replace(&c.f.workspace, &c.f.foreign),
            None,
            true
        )
        .await
        .0,
        404
    );

    sqlx::query("DELETE FROM memberships WHERE user_id=? AND workspace_id=?")
        .bind(&c.f.member)
        .bind(&c.f.workspace)
        .execute(&c.f.db)
        .await
        .unwrap();
    assert_eq!(c.call("GET", &link, None, true).await.0, 403);
    assert_eq!(c.call("GET", &receipt, None, true).await.0, 403);
    assert_eq!(c.withdraw(receipt_item, true).await.0, 403);
    let (_, owner_content) = c.call("GET", &link, None, false).await;
    assert_eq!(owner_content["canModerate"], true);
    c.f.close().await;
}

#[tokio::test]
async fn link_follows_sync_rotates_after_author_withdrawal_and_moderation_blocks_lineage() {
    let c = Case::new().await;
    let policy = c.set_policy(true, json!("unset")).await;
    let (first, proof) = c.skill("Original version", Value::Null).await;
    let (_, result) = c
        .call(
            "PUT",
            &c.publish(&first),
            Some(body(&proof, &Value::Null, &policy)),
            true,
        )
        .await;
    let publication = &result["publication"];
    let old_link = c.link(publication);
    let (next, proof) = c.skill("Next approved version", first["id"].clone()).await;
    let path = c.publish(&next);

    c.transfer_personal(&c.f.owner).await;
    let wrong_publisher = c
        .call(
            "PUT",
            &path,
            Some(body(&proof, &publication["revision"], &Value::Null)),
            false,
        )
        .await;
    assert_eq!(
        (wrong_publisher.0, wrong_publisher.1["code"].as_str()),
        (403, Some("TEAM_SKILL_PUBLISHER_MISMATCH"))
    );
    c.transfer_personal(&c.f.member).await;

    let (status, result) = c
        .call(
            "PUT",
            &path,
            Some(body(&proof, &publication["revision"], &policy)),
            true,
        )
        .await;
    assert_eq!(status, 200, "{result}");
    let synced = &result["publication"];
    assert_eq!(synced["id"], publication["id"]);
    assert_eq!(synced["linkId"], publication["linkId"]);
    assert_eq!(synced["version"], 2);
    assert_eq!(
        c.call("GET", &old_link, None, false).await.1["content"],
        "Next approved version"
    );
    assert_eq!(
        c.withdraw(publication, true).await.1["code"],
        "TEAM_SKILL_REVISION"
    );
    let off = c.set_policy(false, policy).await;
    assert_eq!(c.withdraw(synced, true).await.0, 200);
    let expired = c.call("GET", &old_link, None, true).await;
    assert_eq!(expired.0, 404);
    assert_eq!(expired.1["code"], "TEAM_SKILL_LINK_UNAVAILABLE");

    let policy = c.set_policy(true, off).await;
    let (status, result) = c
        .call(
            "PUT",
            &path,
            Some(body(&proof, &Value::Null, &policy)),
            true,
        )
        .await;
    assert_eq!(status, 200, "{result}");
    let republished = &result["publication"];
    assert_eq!(republished["id"], synced["id"]);
    assert_ne!(republished["linkId"], synced["linkId"]);
    let new_link = c.link(republished);
    assert_eq!(c.call("GET", &old_link, None, true).await, expired);
    assert_eq!(
        c.call("GET", &new_link, None, false).await.1["canModerate"],
        true
    );
    assert_eq!(c.withdraw(republished, true).await.0, 200);
    assert_eq!(c.withdraw(republished, false).await.0, 200);
    assert_eq!(c.call("GET", &new_link, None, true).await, expired);
    let moderated = c
        .call(
            "PUT",
            &path,
            Some(body(&proof, &Value::Null, &policy)),
            true,
        )
        .await;
    assert_eq!(
        (moderated.0, moderated.1["code"].as_str()),
        (409, Some("TEAM_SKILL_MODERATED"))
    );
    let (_, targets) = c.call("GET", &c.targets(&next), None, true).await;
    assert!(c.find_team(&targets).is_none());
    c.f.close().await;
}

#[tokio::test]
async fn template_installed_skill_cannot_be_published() {
    let c = Case::new().await;
    let policy = c.set_policy(true, json!("unset")).await;
    let (skill, proof) = c
        .skill("Installed synthetic instructions", Value::Null)
        .await;
    let store =
        c.f.state
            .workspace
            .get(&c.personal, &c.personal)
            .await
            .unwrap();
    sqlx::query("INSERT INTO bot_install_receipts VALUES(?,?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&c.f.member)
        .bind("synthetic")
        .bind(json!({"skillIds":[skill["id"]]}).to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    let paths = [
        ("GET", c.targets(&skill), None),
        (
            "PUT",
            c.publish(&skill),
            Some(body(&proof, &Value::Null, &policy)),
        ),
        (
            "PUT",
            c.publish(&skill).replace(&c.f.workspace, &c.f.foreign),
            Some(body(&proof, &Value::Null, &Value::Null)),
        ),
    ];
    for (method, path, body) in paths {
        let (status, value) = c.call(method, &path, body, true).await;
        assert_eq!(
            (status, value["code"].as_str()),
            (409, Some("TEAM_SKILL_TEMPLATE_SOURCE"))
        );
    }
    let (_, list) = c.call("GET", &c.f.path("/team-skills"), None, false).await;
    assert_eq!(list, json!([]));
    c.f.close().await;
}
