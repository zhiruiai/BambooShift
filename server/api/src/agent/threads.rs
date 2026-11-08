use crate::{
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(crate) fn unavailable() -> ApiError {
    ApiError::new(409, "原消息或回复线程已不可用。").with_code("THREAD_CONTEXT_UNAVAILABLE")
}

pub(super) fn request(value: Option<&Value>) -> Result<Option<&str>> {
    value
        .map(|value| {
            value
                .as_str()
                .filter(|id| super::messages::opaque(id))
                .ok_or_else(|| ApiError::bad("请选择有效的回复线程。"))
        })
        .transpose()
}

pub(super) async fn root(
    conn: &mut SqliteConnection,
    conversation_id: &str,
    id: &str,
) -> Result<Value> {
    WorkspaceStore::get_in(conn, Table::Messages, id)
        .await?
        .filter(|message| {
            message["conversationId"] == conversation_id && message["threadRootId"].is_null()
        })
        .ok_or_else(unavailable)
}

pub(super) fn belongs(message: &Value, thread: Option<&str>) -> bool {
    message["threadRootId"].as_str() == thread
}

pub(crate) fn stamp(message: &mut Value, thread: Option<&str>) {
    if let Some(id) = thread {
        message["threadRootId"] = json!(id);
    }
}
