use super::registry::ActiveRun;
use crate::{
    error::{ApiError, Result},
    workspace::{WorkspaceStore, model},
};
use serde_json::Value;

/// Freeze each Bot's model independently for the task family. Source-space references
/// are never resolved for shared Bots: the executing workspace supplies their model.
pub(super) async fn resolve(
    store: &WorkspaceStore,
    active: &ActiveRun,
    agent: &Value,
    shared: bool,
) -> Result<Value> {
    if let Some(profile) = active.family.model_profile(&active.agent_id) {
        return Ok(profile);
    }
    let selected = (!shared)
        .then(|| agent["modelProfileId"].as_str())
        .flatten();
    let profile = if let Some(id) = selected {
        model::runtime_profile_config(store, id).await?
    } else if let Some(profile) = active.family.default_model_profile.get() {
        profile.clone()
    } else {
        let profile = model::runtime_config(store).await?;
        active
            .family
            .default_model_profile
            .get_or_init(|| profile)
            .clone()
    };
    if profile["configured"] != true {
        return Err(ApiError::bad(if selected.is_some() {
            "此 Bot 选择的模型尚未配置完成，请检查 Bot 设置中的模型。"
        } else {
            "还没有连接模型服务，请先配置模型。"
        }));
    }
    Ok(active
        .family
        .capture_model_profile(&active.agent_id, profile))
}
