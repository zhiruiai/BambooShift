#![allow(dead_code)]
#[path = "../workspace_support/mod.rs"]
mod workspace_support;
use openbot_backend::{
    shared_bots,
    workspace::{WorkspaceAccess, WorkspaceStore},
};
use serde_json::{Value, json};
use std::sync::Arc;
pub use workspace_support::Fixture;
pub struct Shared {
    pub f: Fixture,
    pub owner_personal: String,
    pub personal: String,
    pub source: Arc<WorkspaceStore>,
    pub agent: String,
    pub share: Value,
}
impl Shared {
    pub async fn new() -> Self {
        let f = Fixture::new().await;
        let data = f.bootstrap().await;
        let agent = data["agents"][0]["id"].as_str().unwrap().to_owned();
        let source = f
            .state
            .workspace
            .get(&f.workspace, &f.workspace)
            .await
            .unwrap();
        let owner_personal = personal(&f, &f.owner).await;
        let personal = personal(&f, &f.member).await;
        let request = json!({"requestId":id(),"expectedRevision":"unset","targetTeamId":f.workspace,"audience":"team","memberIds":[]});
        let (status, response) = f
            .request(
                "PUT",
                &f.path(&format!("/agents/{agent}/sharing")),
                Some(request),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 200, "{response}");
        Self {
            f,
            owner_personal,
            personal,
            source,
            agent,
            share: response["share"].clone(),
        }
    }
    pub fn sharing(&self) -> String {
        self.f.path(&format!("/agents/{}/sharing", self.agent))
    }
    pub fn ref_path(&self) -> String {
        format!("/api/workspaces/{}/shared-bot-references", self.personal)
    }
    pub async fn add(&self) -> Value {
        let (status, result) = self
            .f
            .request(
                "POST",
                &self.ref_path(),
                Some(json!({"requestId":id(),"shareId":self.share["id"]})),
                true,
                Some(&self.f.member),
            )
            .await;
        assert_eq!(status, 201, "{result}");
        result
    }
    pub async fn access(&self) -> WorkspaceAccess {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            "cookie",
            format!("openbot_account={}", self.f.member_token)
                .parse()
                .unwrap(),
        );
        headers.insert("x-openbot-expected-user", self.f.member.parse().unwrap());
        openbot_backend::workspace::access::require(
            &self.f.state,
            &headers,
            &self.personal,
            true,
            true,
        )
        .await
        .unwrap()
    }
    pub async fn update(&mut self, extra: Value) -> Value {
        let mut body = json!({"requestId":id(),"expectedRevision":self.share["revision"],"targetTeamId":self.f.workspace,"audience":"team","memberIds":[]});
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, result) = self
            .f
            .request(
                "PUT",
                &self.sharing(),
                Some(body),
                false,
                Some(&self.f.owner),
            )
            .await;
        assert_eq!(status, 200, "{result}");
        self.share = result["share"].clone();
        result
    }
    pub async fn close(self) {
        self.f.close().await;
    }
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub async fn personal(f: &Fixture, user: &str) -> String {
    let wid = id();
    sqlx::query("INSERT INTO workspaces VALUES(?,'Personal','personal','active',?,1)")
        .bind(&wid)
        .bind(&wid)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',1)")
        .bind(&wid)
        .bind(user)
        .execute(&f.db)
        .await
        .unwrap();
    wid
}
pub async fn resolve(s: &Shared, receipt: &Value) -> shared_bots::ResolvedSharedBot {
    shared_bots::resolve(
        &s.f.state,
        &s.access().await,
        receipt["agentId"].as_str().unwrap(),
    )
    .await
    .unwrap()
}
