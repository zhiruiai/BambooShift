#![allow(dead_code)]
use crate::workspace_support::Fixture;
use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::sync::Arc;
pub struct Transfer {
    pub f: Fixture,
    pub routine: Value,
    pub target: Value,
    pub chat: Value,
}
impl Transfer {
    pub async fn new() -> Self {
        let f = Fixture::new().await;
        sqlx::query("UPDATE workspaces SET kind='personal' WHERE id=?")
            .bind(&f.workspace)
            .execute(&f.db)
            .await
            .unwrap();
        let initial = f.bootstrap().await;
        let (status,target)=f.request("POST",&f.path("/agents"),Some(json!({"name":"Receiving Bot","role":"Synthetic reviewer","description":"For transfer tests","instructions":"Respond only with a synthetic test result.","avatar":"spark","color":"#875cff"})),false,Some(&f.owner)).await;
        assert_eq!(status, 201, "{target}");
        let updated = f.bootstrap().await;
        let chat = updated["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["isGroup"] == false && c["agentIds"] == json!([target["id"]]))
            .unwrap()
            .clone();
        let(status,routine)=f.request("POST",&f.path("/routines"),Some(json!({"agentId":initial["agents"][0]["id"],"conversationId":initial["conversations"][0]["id"],"title":"Existing synthetic plan","prompt":"Report a synthetic result, do not call external tools.","schedule":"daily:09:30","timeZone":"America/New_York","enabled":true})),false,Some(&f.owner)).await;
        assert_eq!(status, 201, "{routine}");
        Self {
            f,
            routine,
            target,
            chat,
        }
    }
    pub async fn store(&self) -> Arc<WorkspaceStore> {
        self.f
            .state
            .workspace
            .get(&self.f.workspace, &self.f.workspace)
            .await
            .unwrap()
    }
    pub fn body(&self) -> Value {
        json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedRoutine":config(&self.routine),"targetAgentId":self.target["id"],"targetConversationId":self.chat["id"]})
    }
    pub fn path(&self) -> String {
        self.f.path(&format!(
            "/routines/{}/transfer",
            self.routine["id"].as_str().unwrap()
        ))
    }
    pub async fn send(&self, body: &Value) -> (u16, Value) {
        self.f
            .request(
                "POST",
                &self.path(),
                Some(body.clone()),
                false,
                Some(&self.f.owner),
            )
            .await
    }
    pub async fn get(&self, id: &str) -> (u16, Value) {
        self.f
            .request(
                "GET",
                &self.f.path(&format!("/routine-transfers/{id}")),
                None,
                false,
                Some(&self.f.owner),
            )
            .await
    }
    pub async fn cancel(&self, id: &str) -> (u16, Value) {
        self.f
            .request(
                "POST",
                &self.f.path(&format!("/routine-transfers/{id}/cancel")),
                Some(json!({})),
                false,
                Some(&self.f.owner),
            )
            .await
    }
    pub async fn current(&self) -> Value {
        self.store()
            .await
            .get(Table::Routines, self.routine["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()
    }
}
pub fn config(routine: &Value) -> Value {
    let mut value = json!({});
    for key in [
        "agentId",
        "conversationId",
        "title",
        "prompt",
        "schedule",
        "timeZone",
        "enabled",
        "publicSearchQueries",
    ] {
        if let Some(v) = routine.get(key) {
            value[key] = v.clone();
        }
    }
    value
}
pub async fn idle(f: &Fixture) {
    for _ in 0..500 {
        if !f.state.agent_runs.workspace_busy(&f.workspace).await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("Synthetic run did not finish");
}
