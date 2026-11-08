use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn project_revision(agent: &mut Value) {
    if agent["configRevision"]
        .as_str()
        .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
    {
        return;
    }
    let mut fields = vec![agent["id"].clone()];
    for field in [
        "name",
        "role",
        "description",
        "instructions",
        "color",
        "avatar",
    ] {
        fields.push(agent[field].clone());
    }
    if agent["avatarImageId"]
        .as_str()
        .is_some_and(|v| !v.is_empty())
    {
        fields.push(agent["avatarImageId"].clone());
    }
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&fields).unwrap_or_default(),
    ));
    agent["configRevision"] = json!(format!(
        "{}-{}-{}-{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32]
    ));
}
pub fn validate(body: &Value, partial: bool) -> Result<Value> {
    crate::error::only_fields(
        body,
        &[
            "name",
            "role",
            "description",
            "instructions",
            "color",
            "avatar",
            "avatarImageId",
        ],
    )?;
    let mut result = if partial {
        json!({})
    } else {
        json!({"role":"工作搭档","description":"","instructions":"用中文帮助用户完成工作，以实际执行结果为依据。","avatar":"orb","color":"#8b5cf6"})
    };
    for (key, max, empty) in [
        ("name", 40, false),
        ("role", 80, false),
        ("description", 1000, true),
        ("instructions", 16000, true),
    ] {
        if let Some(value) = body.get(key) {
            let value = value
                .as_str()
                .ok_or_else(|| ApiError::bad("Bot资料必须是文本。"))?;
            if value.encode_utf16().count() > max
                || value.contains('\0')
                || (!empty && value.trim().is_empty())
            {
                return Err(ApiError::bad("Bot资料为空或过长。"));
            }
            result[key] = json!(value.trim());
        } else if key == "name" && !partial {
            return Err(ApiError::bad("请填写Bot名字。"));
        }
    }
    if let Some(color) = body.get("color") {
        let color = color
            .as_str()
            .filter(|v| {
                v.len() == 7 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_hexdigit())
            })
            .ok_or_else(|| ApiError::bad("头像颜色无效。"))?;
        result["color"] = json!(color.to_lowercase());
    }
    if let Some(avatar) = body.get("avatar") {
        let avatar = avatar
            .as_str()
            .filter(|v| ["orb", "drop", "leaf", "spark", "gem", "arch"].contains(v))
            .ok_or_else(|| ApiError::bad("头像形象无效。"))?;
        result["avatar"] = json!(avatar);
    }
    if let Some(image) = body.get("avatarImageId") {
        if !image.is_null()
            && !image
                .as_str()
                .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
        {
            return Err(ApiError::bad("头像标识无效。"));
        }
        result["avatarImageId"] = image.clone();
    }
    Ok(result)
}
