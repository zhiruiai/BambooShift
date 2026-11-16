use super::{
    controller::Controller,
    controls, model, private_config,
    transport::{Authority, Target},
};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::{WorkspaceAccess, WorkspaceStore},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Grant {
    id: String,
    user_id: String,
    target: String,
    granted_at: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Journal {
    version: u8,
    workspace_id: String,
    grants: Vec<Grant>,
}
pub(crate) fn load(store: &WorkspaceStore) -> Result<Journal> {
    let Some(bytes) = private_config::read_private(
        &store.directory.join("computer/authorization.json"),
        256 * 1024,
    )?
    else {
        return Ok(Journal {
            version: 1,
            workspace_id: store.workspace_id.clone(),
            grants: vec![],
        });
    };
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| model::invalid())?;
    if journal.version != 1
        || journal.workspace_id != store.workspace_id
        || journal.grants.len() > 1000
        || journal.grants.iter().any(|grant| {
            !model::uuid(&grant.id)
                || !model::opaque(&grant.user_id)
                || grant.target.len() != 64
                || !grant.target.bytes().all(|b| b.is_ascii_hexdigit())
                || chrono::DateTime::parse_from_rfc3339(&grant.granted_at).is_err()
        })
    {
        return Err(model::invalid());
    }
    Ok(journal)
}
// Hardware identity keeps a local grant across app restarts without carrying it to a copied profile.
pub(crate) fn local_host_identity() -> String {
    #[cfg(target_os = "macos")]
    {
        let mut id = [0u8; 16];
        let timeout = libc::timespec {
            tv_sec: 1,
            tv_nsec: 0,
        };
        if unsafe { libc::gethostuuid(id.as_mut_ptr(), &timeout) } == 0 && id != [0; 16] {
            return hex::encode(id);
        }
    }
    #[cfg(target_os = "linux")]
    if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
        if id.trim().len() == 32 {
            return id.trim().into();
        }
    }
    // An unknown host gets a session-only grant instead of an unbound persistent grant.
    uuid::Uuid::new_v4().to_string()
}
fn local_identity(controller: &Controller) -> Value {
    json!([
        "local",
        controller.local_host_identity,
        controller.store.workspace_id
    ])
}
// Startup runs before the new target is installed. Match the same durable local
// grant without taking the current-target mutex, and revalidate the owner.
pub(crate) async fn local_grant(
    controller: &Controller,
    user: Option<&str>,
) -> Result<Option<(String, String)>> {
    let key = hex::encode(Sha256::digest(
        serde_json::to_vec(&local_identity(controller)).unwrap(),
    ));
    let candidates = controller.authorization.lock().await.grants.clone();
    for grant in candidates {
        if grant.target == key
            && user.is_none_or(|user| user == grant.user_id)
            && owner(controller, &grant.user_id).await?
        {
            return Ok(Some((grant.user_id, grant.id)));
        }
    }
    Ok(None)
}
async fn target_key(controller: &Controller, target: &Target) -> Result<String> {
    target.active()?;
    let saved = controller
        .saved
        .lock()
        .await
        .clone()
        .ok_or_else(model::invalid)?;
    let identity = if saved.selection == "local" {
        let current = controller.target.lock().await;
        if !current
            .as_ref()
            .is_some_and(|value| std::ptr::eq(value.as_ref(), target))
        {
            return Err(model::invalid());
        }
        local_identity(controller)
    } else if saved.selection == "remote" {
        let remote = saved.remote.ok_or_else(model::invalid)?;
        if remote.instance_id != target.saved.instance_id
            || remote.url != target.saved.url
            || remote.token != target.saved.token
            || remote.control_origin != target.saved.control_origin
        {
            return Err(model::invalid());
        }
        json!([
            "remote",
            remote.url,
            remote.token,
            remote.instance_id,
            remote.control_origin
        ])
    } else {
        return Err(model::invalid());
    };
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(&identity).unwrap(),
    )))
}
async fn owner(controller: &Controller, user: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.workspace_id=? AND m.role='owner' AND u.status='active' AND w.status='active'")
        .bind(user).bind(&controller.store.workspace_id).fetch_one(&controller.identity_pool).await? > 0)
}
async fn grant(controller: &Controller, target: &Target, user: &str) -> Result<Option<Grant>> {
    if !owner(controller, user).await? {
        return Ok(None);
    }
    let key = target_key(controller, target).await?;
    Ok(controller
        .authorization
        .lock()
        .await
        .grants
        .iter()
        .find(|grant| grant.user_id == user && grant.target == key)
        .cloned())
}
pub(crate) async fn snapshot(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    user: &str,
    can_manage: bool,
) -> Result<Value> {
    let shared = controller.uses_shared_screen().await;
    let target = if shared || agent.is_none() {
        controller.target.lock().await.clone()
    } else {
        controller
            .screen_targets
            .lock()
            .await
            .get(agent.unwrap())
            .cloned()
    };
    let mut value = json!({"mode":"confirm","scope":"current-user-current-computer",
        "targetRevision":null,"targetName":null,"canManage":can_manage});
    if let Some(target) = target.filter(|t| !t.is_closed() && !t.is_blocked()) {
        value["targetRevision"] = target.state().await["targetRevision"].clone();
        value["targetName"] = json!(target.saved.name);
        match grant(controller, &target, user).await {
            Ok(Some(grant)) => {
                value["mode"] = json!("full");
                value["grantedAt"] = json!(grant.granted_at);
            }
            Ok(None) => {}
            Err(_) => value["canManage"] = json!(false),
        }
    }
    Ok(value)
}
pub(crate) async fn set(
    controller: &Arc<Controller>,
    agent: Option<&str>,
    actor: &WorkspaceAccess,
    body: &Value,
    authorize: Authority,
) -> Result<Value> {
    crate::error::only_fields(body, &["mode", "expectedTargetRevision"])?;
    if !matches!(body["mode"].as_str(), Some("full" | "confirm")) {
        return Err(ApiError::bad("请选择有效的电脑授权方式。"));
    }
    // Revocation must not wait behind a request blocked on the worker queue.
    let guard = if body["mode"] == "full" {
        Some(controller.management.lock().await)
    } else {
        None
    };
    controller.active()?;
    authorize().await?;
    if !actor.is_owner || !owner(controller, &actor.user_id).await? {
        return Err(ApiError::new(
            403,
            "只有工作空间所有者可以更改电脑完整授权。",
        ));
    }
    let key = if body["mode"] == "full" {
        let target = controls::target(controller, agent, authorize.clone()).await?;
        if body["expectedTargetRevision"] != target.state().await["targetRevision"] {
            return Err(ApiError::new(409, "工作电脑已切换，请刷新后再授权。")
                .with_code("COMPUTER_TARGET_CHANGED"));
        }
        target_key(controller, &target).await?
    } else {
        String::new()
    };
    let mut current = controller.authorization.lock().await;
    let mut next = current.clone();
    let existing = next
        .grants
        .iter()
        .find(|grant| grant.user_id == actor.user_id && grant.target == key)
        .cloned();
    next.grants.retain(|grant| grant.user_id != actor.user_id);
    if body["mode"] == "full" {
        if next.grants.len() >= 1000 {
            return Err(ApiError::new(409, "电脑授权记录已满。"));
        }
        next.grants.push(existing.unwrap_or_else(|| Grant {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: actor.user_id.clone(),
            target: key,
            granted_at: iso(now()),
        }));
    }
    authorize().await?;
    private_config::atomic_private(
        &controller
            .store
            .directory
            .join("computer/authorization.json"),
        &serde_json::to_vec(&next).map_err(|_| model::invalid())?,
    )?;
    *current = next;
    drop(current);
    drop(guard);
    controller.changed();
    if body["mode"] == "full" {
        let controller = controller.clone();
        let user = actor.user_id.clone();
        tokio::spawn(async move {
            // Each start rechecks the saved grant. Returning the setting must not
            // wait behind a previously authorized long-running command.
            let _ = super::approvals::apply_authorization(&controller, &user).await;
        });
    }
    snapshot(controller, agent, &actor.user_id, true).await
}
pub(crate) async fn automatic(
    controller: &Arc<Controller>,
    target: &Arc<Target>,
    requester: Option<&Value>,
) -> Result<Option<(Authority, Value)>> {
    let Some(user) = requester.and_then(|r| r["userId"].as_str()) else {
        return Ok(None);
    };
    let Some(grant) = grant(controller, target, user).await? else {
        return Ok(None);
    };
    let details =
        json!({"mode":"full","scope":"current-user-current-computer","grantedAt":grant.granted_at});
    let (controller, target) = (Arc::downgrade(controller), target.clone());
    let check: Authority = Arc::new(move || {
        let (controller, target, expected) = (controller.clone(), target.clone(), grant.clone());
        Box::pin(async move {
            let controller = controller.upgrade().ok_or_else(model::invalid)?;
            controller.active()?;
            if self::grant(&controller, &target, &expected.user_id)
                .await?
                .is_some_and(|current| current.id == expected.id)
            {
                return Ok(());
            }
            Err(ApiError::new(409, "电脑完整授权已撤回，当前操作已停止。"))
        })
    });
    Ok(Some((check, details)))
}

pub fn user_authority(state: &State, actor: &WorkspaceAccess) -> Authority {
    let state = state.clone();
    let actor = actor.clone();
    Arc::new(move || {
        let state = state.clone();
        let actor = actor.clone();
        Box::pin(async move { actor.authorize(&state).await })
    })
}

impl Controller {
    pub(crate) fn changed(&self) {
        self.store.emit("update", json!({}));
    }
}
