use crate::{
    error::{ApiError, Result, only_fields, text},
    workspace::{Table, WorkspaceStore, mutations, profiles, time_zone},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};

#[derive(Clone)]
pub struct Snapshot {
    pub blueprint: Value,
    pub avatar: Option<Vec<u8>>,
    pub revision: String,
}
pub fn hash(value: &Value) -> String {
    bytes_hash(value.to_string().as_bytes())
}
pub fn bytes_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn opaque(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 128
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        .ok_or_else(|| ApiError::bad("Bot 模板标识无效。"))
}
pub fn uuid(value: &Value) -> Result<&str> {
    let value = opaque(value)?;
    if uuid::Uuid::parse_str(value)
        .ok()
        .is_none_or(|id| id.to_string() != value)
    {
        return Err(ApiError::bad("Bot 模板请求标识无效。"));
    }
    Ok(value)
}
fn optional_text(value: &Value, max: usize) -> Result<String> {
    let value = value
        .as_str()
        .filter(|s| s.encode_utf16().count() <= max && !s.contains('\0'))
        .ok_or_else(|| ApiError::bad("Bot 模板文本无效。"))?;
    Ok(value.trim().to_owned())
}
pub fn validate(input: &Value, avatar: Option<&[u8]>) -> Result<Value> {
    only_fields(
        input,
        &["version", "profile", "skills", "routines", "avatar"],
    )?;
    if input["version"] != 1 || input.to_string().len() > 2 * 1024 * 1024 {
        return Err(ApiError::bad("Bot 模板版本无效或内容过大。"));
    }
    let fields = [
        "name",
        "role",
        "description",
        "instructions",
        "color",
        "avatar",
    ];
    only_fields(&input["profile"], &fields)?;
    if fields.iter().any(|key| input["profile"].get(key).is_none()) {
        return Err(ApiError::bad("Bot 模板资料不完整。"));
    }
    let profile = profiles::validate(&input["profile"], false)?;
    let raw_skills = input["skills"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or_else(|| ApiError::bad("Bot 模板技能数量无效。"))?;
    let raw_routines = input["routines"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or_else(|| ApiError::bad("Bot 模板任务数量无效。"))?;
    let mut names = std::collections::HashSet::new();
    let mut skills = Vec::new();
    for skill in raw_skills {
        only_fields(skill, &["name", "description", "content"])?;
        let name = text(&skill["name"], "技能名称", 100)?;
        if !names.insert(name.clone()) {
            return Err(ApiError::bad("Bot 模板不能包含同名启用技能。"));
        }
        skills.push(json!({"name":name,"description":optional_text(&skill["description"],1000)?,"content":text(&skill["content"],"技能内容",16000)?}));
    }
    let mut routines = Vec::new();
    for routine in raw_routines {
        only_fields(
            routine,
            &["title", "prompt", "schedule", "enabled", "timeZone"],
        )?;
        let enabled = routine["enabled"]
            .as_bool()
            .ok_or_else(|| ApiError::bad("Bot 模板任务状态无效。"))?;
        let schedule = time_zone::normalize_schedule(
            routine["schedule"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Bot 模板任务频率无效。"))?,
        )?;
        let mut value = json!({"title":text(&routine["title"],"任务名称",100)?,"prompt":text(&routine["prompt"],"任务内容",12000)?,"schedule":schedule,"enabled":enabled});
        if let Some(zone) = routine.get("timeZone") {
            value["timeZone"] = json!(time_zone::normalize(zone)?);
        }
        routines.push(value);
    }
    let mut result = json!({"version":1,"profile":profile,"skills":skills,"routines":routines});
    if let Some(meta) = input.get("avatar") {
        only_fields(meta, &["mimeType", "sha256", "width", "height"])?;
        let bytes = avatar
            .filter(|b| !b.is_empty() && b.len() <= 512 * 1024)
            .ok_or_else(|| ApiError::bad("Bot 模板头像数据不完整。"))?;
        if meta["mimeType"] != "image/webp"
            || meta["width"] != 512
            || meta["height"] != 512
            || meta["sha256"] != bytes_hash(bytes)
        {
            return Err(ApiError::bad("Bot 模板头像校验失败。"));
        }
        result["avatar"] = meta.clone();
    } else if avatar.is_some() {
        return Err(ApiError::bad("Bot 模板头像缺少说明。"));
    }
    Ok(result)
}
pub async fn capture(conn: &mut SqliteConnection, id: &str) -> Result<Snapshot> {
    opaque(&json!(id))?;
    let agent = mutations::find(conn, Table::Agents, id).await?;
    mutations::local(&agent)?;
    let mut profile = json!({});
    for key in [
        "name",
        "role",
        "description",
        "instructions",
        "color",
        "avatar",
    ] {
        profile[key] = agent[key].clone();
    }
    let mut skills = WorkspaceStore::list_in(conn, Table::Skills)
        .await?
        .into_iter()
        .filter(|s| {
            s["agentId"] == id
                && s["status"] == "active"
                && s.get("teamSource").is_none()
                && s.get("privateSource").is_none()
        })
        .collect::<Vec<_>>();
    let mut routines = WorkspaceStore::list_in(conn, Table::Routines)
        .await?
        .into_iter()
        .filter(|r| {
            r["agentId"] == id && r["schedule"] != crate::scheduling::routines::WEBHOOK_SCHEDULE
        })
        .collect::<Vec<_>>();
    skills.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    routines.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let portable_skills = skills
        .iter()
        .map(|s| json!({"name":s["name"],"description":s["description"],"content":s["content"]}))
        .collect::<Vec<_>>();
    let portable_routines=routines.iter().map(|r| { let mut v=json!({"title":r["title"],"prompt":r["prompt"],"schedule":r["schedule"],"enabled":r["enabled"]}); if let Some(z)=r.get("timeZone") {v["timeZone"]=z.clone();} v }).collect::<Vec<_>>();
    let mut blueprint = json!({"version":1,"profile":profile,"skills":portable_skills,"routines":portable_routines});
    let avatar = if let Some(image) = agent.get("avatarImageId").filter(|v| !v.is_null()) {
        let row=sqlx::query("SELECT data,bytes FROM avatar_assets WHERE id=? AND published=1 AND length(bytes)<=524288").bind(uuid(image)?).fetch_optional(&mut *conn).await?.ok_or_else(||ApiError::new(409,"Bot 头像不可用，请修复后重试。"))?;
        let meta: Value = serde_json::from_str(row.get("data"))
            .map_err(|_| ApiError::new(409, "Bot 头像不可用。"))?;
        let bytes: Vec<u8> = row.get("bytes");
        if meta["id"] != *image
            || meta["width"] != 512
            || meta["height"] != 512
            || meta["mimeType"] != "image/webp"
        {
            return Err(ApiError::new(409, "Bot 头像不可用。"));
        }
        blueprint["avatar"] =
            json!({"mimeType":"image/webp","width":512,"height":512,"sha256":bytes_hash(&bytes)});
        Some(bytes)
    } else {
        None
    };
    let blueprint = validate(&blueprint, avatar.as_deref())?;
    let revision = hash(
        &json!({"agentId":id,"configRevision":agent["configRevision"],"blueprint":blueprint,"skillSources":skills.iter().map(|s|json!({"id":s["id"],"version":s["version"]})).collect::<Vec<_>>(),"routineSources":routines.iter().map(|r|json!({"id":r["id"],"conversationId":r["conversationId"]})).collect::<Vec<_>>()}),
    );
    Ok(Snapshot {
        blueprint,
        avatar,
        revision,
    })
}
