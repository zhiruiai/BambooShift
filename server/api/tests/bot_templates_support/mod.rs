#![allow(dead_code)]
#[path = "../workspace_support/mod.rs"]
mod workspace_support;
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::sync::Arc;
pub use workspace_support::Fixture;

pub struct Templates {
    pub f: Fixture,
    pub store: Arc<WorkspaceStore>,
    pub agent: String,
    pub conversation: String,
}
impl Templates {
    pub async fn new() -> Self {
        let f = Fixture::new().await;
        let data = f.bootstrap().await;
        let agent = data["agents"][0]["id"].as_str().unwrap().to_owned();
        let conversation = data["conversations"][0]["id"].as_str().unwrap().to_owned();
        let store = f
            .state
            .workspace
            .get(&f.workspace, &f.workspace)
            .await
            .unwrap();
        for (name, status) in [
            ("Accepted method", "active"),
            ("Private proposal", "proposed"),
        ] {
            store.put(Table::Skills,&json!({"id":id(),"agentId":agent,"name":name,"description":"Synthetic method","content":"Use only documented observations.","version":1,"status":status,"createdAt":"2026-11-01T00:00:00.000Z"})).await.unwrap();
        }
        store.put(Table::Routines,&json!({"id":id(),"agentId":agent,"conversationId":conversation,"title":"Synthetic reminder","prompt":"Review progress.","schedule":"daily:09:00","enabled":true,"nextRunAt":"2029-01-01T00:00:00.000Z"})).await.unwrap();
        store.put(Table::Memories,&json!({"id":id(),"agentId":agent,"content":"PRIVATE MEMORY MUST NOT COPY","category":"preference","createdAt":"2026-11-01T00:00:00.000Z"})).await.unwrap();
        Self {
            f,
            store,
            agent,
            conversation,
        }
    }
    pub async fn call(&self, method: &str, suffix: &str, body: Option<Value>) -> (u16, Value) {
        self.f
            .request(
                method,
                &self.f.path(suffix),
                body,
                false,
                Some(&self.f.owner),
            )
            .await
    }
    pub async fn source(&self) -> Value {
        let (status, value) = self
            .call("GET", &format!("/bot-copy-source/{}", self.agent), None)
            .await;
        assert_eq!(status, 200, "{value}");
        value
    }
    pub async fn create(&self) -> Value {
        let preview = self.source().await;
        let (status,value)=self.call("POST","/bot-templates",Some(json!({"requestId":id(),"sourceAgentId":self.agent,"sourceConversationId":self.conversation,"expectedSourceRevision":preview["sourceRevision"]}))).await;
        assert_eq!(status, 201, "{value}");
        value
    }
    pub async fn publish(&self, template: &Value, audience: &str) -> Value {
        let (status,value)=self.call("POST",&format!("/bot-templates/{}/publish",template["id"].as_str().unwrap()),Some(json!({"requestId":id(),"expectedRevision":template["revision"],"expectedDraftRevision":template["draftRevision"],"audience":audience}))).await;
        assert_eq!(status, 200, "{value}");
        value
    }
    pub async fn public_policy(&self) {
        let (status, value) = self.call("GET", "/bot-sharing-policy", None).await;
        assert_eq!(status, 200);
        let (status, value) = self
            .call(
                "PUT",
                "/bot-sharing-policy",
                Some(json!({"expectedRevision":value["revision"],"mode":"public"})),
            )
            .await;
        assert_eq!(status, 200, "{value}");
    }
    pub async fn personal(&self, user: &str) -> String {
        let wid = id();
        sqlx::query("INSERT INTO workspaces VALUES(?,'Personal','personal','active',?,1)")
            .bind(&wid)
            .bind(&wid)
            .execute(&self.f.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',1)")
            .bind(&wid)
            .bind(user)
            .execute(&self.f.db)
            .await
            .unwrap();
        wid
    }
    pub async fn close(self) {
        self.f.close().await;
    }
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn token(template: &Value) -> String {
    template["publication"]["path"]
        .as_str()
        .unwrap()
        .strip_prefix("/templates/")
        .unwrap()
        .to_owned()
}
pub fn webp() -> Vec<u8> {
    let rgba = vec![170_u8; 512 * 512 * 4];
    webp::Encoder::from_rgba(&rgba, 512, 512)
        .encode_lossless()
        .to_vec()
}
