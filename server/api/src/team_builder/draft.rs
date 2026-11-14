use crate::{
    error::{ApiError, Result, only_fields, text},
    workspace::profiles,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::collections::HashSet;

pub fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).unwrap_or_default(),
    ))
}
pub fn uuid(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| ApiError::bad("方案请求或版本标识无效。"))
}
fn key(value: &Value) -> Result<String> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 40
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        })
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad("成员标识无效。"))
}
pub fn profile(agent: &Value) -> Value {
    let mut result = json!({});
    for field in [
        "name",
        "role",
        "description",
        "instructions",
        "avatar",
        "color",
        "avatarImageId",
    ] {
        if let Some(v) = agent.get(field) {
            result[field] = v.clone();
        }
    }
    if let Some(shared) = agent.get("sharedBot") {
        let mut metadata = json!({});
        for field in [
            "shareId",
            "sourceRevision",
            "ownerName",
            "sourceWorkspaceName",
            "teamName",
            "status",
            "avatarPath",
        ] {
            if let Some(v) = shared.get(field) {
                metadata[field] = v.clone();
            }
        }
        result["sharedBot"] = metadata;
    } else if let Some(profile) = agent.get("modelProfileId") {
        result["modelProfileId"] = profile.clone();
    }
    result
}
pub fn version(agent: &Value) -> String {
    let mut data = vec![
        agent["configRevision"].clone(),
        agent["name"].clone(),
        agent["role"].clone(),
        agent["description"].clone(),
        agent["instructions"].clone(),
        agent["color"].clone(),
        agent["avatar"].clone(),
    ];
    if agent["avatarImageId"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        data.push(agent["avatarImageId"].clone());
    }
    if agent.get("sharedBot").is_some() {
        data.push(profile(agent)["sharedBot"].clone());
    } else if let Some(profile) = agent.get("modelProfileId") {
        data.push(profile.clone());
    }
    digest(&json!(data))
}
pub fn reusable(agent: &Value) -> Result<()> {
    if agent.get("sharedBot").is_some()
        && (agent["sharedBot"]["status"] != "active"
            || agent["sharedBot"]["shareId"].as_str().is_none())
    {
        return Err(ApiError::new(
            409,
            "共享 Bot 的来源尚未连接，请选择可用成员后重新核对。",
        ));
    }
    Ok(())
}
pub fn catalog(agents: &[Value]) -> Value {
    let mut map = json!({});
    for a in agents {
        if let Some(id) = a["id"].as_str() {
            map[id] = json!(version(a));
        }
    }
    map
}
pub async fn validate(
    conn: &mut SqliteConnection,
    value: &Value,
    agents: &[Value],
    editable: Option<&Value>,
    human: bool,
    incomplete: bool,
) -> Result<Value> {
    only_fields(value, &["title", "summary", "leadKey", "members"])?;
    if value.to_string().len() > 128 * 1024 {
        return Err(ApiError::new(413, "团队方案过长。"));
    }
    let title = text(&value["title"], "工作组名称", 100)?;
    let summary = text(&value["summary"], "协作说明", 2000)?;
    let lead = key(&value["leadKey"])?;
    let members = value["members"]
        .as_array()
        .filter(|v| v.len() >= if incomplete { 1 } else { 2 } && v.len() <= 6)
        .ok_or_else(|| ApiError::bad("新工作组需要 2–6 位 Bot。"))?;
    let mut seen = HashSet::new();
    let mut reused = HashSet::new();
    let mut names = HashSet::new();
    let mut result = Vec::new();
    for member in members {
        let member_key = key(&member["key"])?;
        if !seen.insert(member_key.clone()) {
            return Err(ApiError::bad("成员标识不能重复。"));
        }
        let assignment = text(&member["assignment"], "成员分工", 2000)?;
        match member["kind"].as_str() {
            Some("reuse") => {
                only_fields(member, &["key", "kind", "agentId", "assignment"])?;
                let id = member["agentId"]
                    .as_str()
                    .filter(|v| {
                        !v.is_empty()
                            && v.len() <= 128
                            && v.bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                    })
                    .ok_or_else(|| ApiError::bad("Bot 标识无效。"))?;
                if !reused.insert(id) {
                    return Err(ApiError::bad("同一 Bot 不能重复加入团队。"));
                }
                match agents.iter().find(|a| a["id"] == id) {
                    Some(agent) if editable.is_none() => reusable(agent)?,
                    Some(_) => {}
                    None if editable.is_some_and(|c| c.get(id).is_some()) => {}
                    None => return Err(ApiError::new(409, "复用的 Bot 已不存在，请重新选择。")),
                }
                result.push(
                    json!({"key":member_key,"kind":"reuse","agentId":id,"assignment":assignment}),
                );
            }
            Some("create") => {
                let mut allowed = vec![
                    "key",
                    "kind",
                    "name",
                    "role",
                    "description",
                    "instructions",
                    "color",
                    "avatar",
                    "assignment",
                ];
                if human {
                    allowed.push("avatarImageId");
                    allowed.push("modelProfileId");
                }
                only_fields(member, &allowed)?;
                let mut fields = json!({});
                for field in [
                    "name",
                    "role",
                    "description",
                    "instructions",
                    "color",
                    "avatar",
                ] {
                    fields[field] = member
                        .get(field)
                        .ok_or_else(|| ApiError::bad("新增 Bot 资料不完整。"))?
                        .clone();
                }
                if let Some(image) = member.get("avatarImageId") {
                    fields["avatarImageId"] = image.clone();
                }
                if let Some(profile) = member.get("modelProfileId") {
                    fields["modelProfileId"] = profile.clone();
                }
                let settings = profiles::validate(&fields, false)?;
                if let Some(image) = settings["avatarImageId"].as_str() {
                    let exists = sqlx::query("SELECT 1 FROM avatar_assets WHERE id=?")
                        .bind(image)
                        .fetch_optional(&mut *conn)
                        .await?;
                    if exists.is_none() {
                        return Err(ApiError::new(409, "头像不存在或不属于当前空间。"));
                    }
                }
                let name = settings["name"].as_str().unwrap().to_lowercase();
                if !names.insert(name.clone())
                    || (editable.is_none()
                        && agents
                            .iter()
                            .any(|a| a["name"].as_str().unwrap_or("").to_lowercase() == name))
                {
                    return Err(ApiError::new(
                        409,
                        "已有同名 Bot，请优先复用或修改新 Bot 名称。",
                    ));
                }
                let mut out = settings;
                out["key"] = json!(member_key);
                out["kind"] = json!("create");
                out["assignment"] = json!(assignment);
                result.push(out);
            }
            _ => return Err(ApiError::bad("成员类型无效。")),
        }
    }
    if !seen.contains(&lead) {
        return Err(ApiError::bad("请指定团队中的一位负责人。"));
    }
    Ok(json!({"title":title,"summary":summary,"leadKey":lead,"members":result}))
}
