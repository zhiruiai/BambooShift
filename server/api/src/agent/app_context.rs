use crate::{
    apps::{model::Connection, store, tool_access},
    error::{ApiError, Result, only_fields},
    workspace::WorkspaceStore,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqliteConnection;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppContext {
    pub connection_id: String,
    pub revision: String,
    pub name: String,
}

fn unavailable() -> ApiError {
    ApiError::new(409, "选中的应用已变更或断开。请移除后重新选择。")
        .with_code("APP_CONTEXT_UNAVAILABLE")
}

pub(super) fn request(value: Option<&Value>) -> Result<Option<(&str, &str)>> {
    let Some(value) = value else { return Ok(None) };
    only_fields(value, &["connectionId", "revision"])?;
    value["connectionId"]
        .as_str()
        .filter(|id| super::messages::opaque(id))
        .zip(
            value["revision"]
                .as_str()
                .filter(|revision| super::messages::opaque(revision)),
        )
        .map(Some)
        .ok_or_else(|| ApiError::bad("应用选择参数无效。"))
}

impl AppContext {
    pub(super) async fn capture(
        tx: &mut SqliteConnection,
        connection_id: &str,
        revision: &str,
    ) -> Result<Self> {
        let connection = Self::matching(tx, connection_id, revision).await?;
        Ok(Self {
            connection_id: connection.id,
            revision: connection.revision,
            name: connection.name,
        })
    }

    async fn matching(
        tx: &mut SqliteConnection,
        connection_id: &str,
        revision: &str,
    ) -> Result<Connection> {
        store::connection_in(tx, connection_id)
            .await?
            .filter(|app| {
                app.revision == revision
                    && app.status == "connected"
                    && app.tools.iter().any(|tool| enabled(app, tool))
            })
            .ok_or_else(unavailable)
    }

    pub(super) async fn current(&self, workspace: &WorkspaceStore) -> Result<Connection> {
        let mut connection = workspace.pool.acquire().await?;
        Self::matching(&mut connection, &self.connection_id, &self.revision).await
    }

    pub(super) fn require_id(&self, id: &str) -> Result<()> {
        if self.connection_id != id {
            return Err(ApiError::new(403, "本次任务仅可使用用户选中的应用。"));
        }
        Ok(())
    }

    pub(super) fn authorize_call(&self, id: &str, revision: &str) -> Result<()> {
        self.require_id(id)?;
        if self.revision != revision {
            return Err(unavailable());
        }
        Ok(())
    }

    pub(super) fn local_only() -> ApiError {
        ApiError::new(403, "选中的工作空间应用只能用于本地 Bot。")
            .with_code("APP_CONTEXT_LOCAL_BOT_ONLY")
    }
}

pub(super) fn enabled(connection: &Connection, tool: &Value) -> bool {
    tool["name"]
        .as_str()
        .is_some_and(|name| tool_access::enabled(connection, name))
}
