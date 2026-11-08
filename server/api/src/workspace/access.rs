use super::WorkspaceStore;
use crate::{
    db::{State, now},
    error::{ApiError, Result},
    sessions, workspaces,
};
use axum::http::HeaderMap;
use sqlx::{Row, SqliteConnection};
use std::sync::Arc;

#[derive(Clone)]
pub struct WorkspaceAccess {
    pub user_id: String,
    pub user_name: String,
    pub session_id: String,
    pub workspace_id: String,
    pub storage_key: String,
    pub is_owner: bool,
    pub kind: String,
    owner_required: bool,
}
pub async fn require(
    state: &State,
    headers: &HeaderMap,
    id: &str,
    owner: bool,
    strong_expected: bool,
) -> Result<WorkspaceAccess> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(ApiError::new(403, "工作空间不可用。"));
    }
    let mut conn = state.pool.acquire().await?;
    let identity = sessions::require(&mut conn, state, headers, "account").await?;
    if (strong_expected || headers.contains_key("x-openbot-expected-user"))
        && headers
            .get("x-openbot-expected-user")
            .and_then(|h| h.to_str().ok())
            != Some(identity.user.id.as_str())
    {
        return Err(ApiError::new(403, "请确认当前账户后重试。"));
    }
    let workspace = workspaces::membership(&mut conn, &identity.user.id, id, owner, false).await?;
    let key: String = sqlx::query_scalar("SELECT storage_key FROM workspaces WHERE id=?")
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(WorkspaceAccess {
        user_id: identity.user.id,
        user_name: identity.user.name,
        session_id: identity.session_id,
        workspace_id: id.to_owned(),
        storage_key: key,
        is_owner: workspace.role == "owner",
        kind: workspace.kind,
        owner_required: owner,
    })
}
impl WorkspaceAccess {
    pub async fn authorize(&self, state: &State) -> Result<()> {
        self.authorize_in(&mut *state.pool.acquire().await?).await
    }
    pub(crate) async fn authorize_in(&self, conn: &mut SqliteConnection) -> Result<()> {
        self.owner_in(conn).await.map(|_| ())
    }
    pub(super) async fn owner_in(&self, conn: &mut SqliteConnection) -> Result<bool> {
        let row=sqlx::query("SELECT m.role,w.storage_key FROM account_sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE s.id=? AND s.user_id=? AND s.purpose='account' AND s.expires_at>? AND u.status='active' AND w.id=? AND w.status='active'")
            .bind(&self.session_id).bind(&self.user_id).bind(now()).bind(&self.workspace_id).fetch_optional(conn).await?.ok_or_else(||ApiError::new(403,"账户或工作空间权限已失效。"))?;
        let is_owner = row.get::<String, _>("role") == "owner";
        if (self.owner_required && !is_owner)
            || row.get::<String, _>("storage_key") != self.storage_key
        {
            return Err(ApiError::new(403, "工作空间权限已变化。"));
        }
        Ok(is_owner)
    }
    pub async fn authorize_owner(&self, state: &State) -> Result<()> {
        let mut owner = self.clone();
        owner.owner_required = true;
        owner.authorize(state).await
    }
    pub async fn store(&self, state: &State) -> Result<Arc<WorkspaceStore>> {
        self.authorize(state).await?;
        let store = state
            .workspace
            .get(&self.workspace_id, &self.storage_key)
            .await?;
        self.authorize(state).await?;
        Ok(store)
    }
}
