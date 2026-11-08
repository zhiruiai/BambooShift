use super::store::{Share, opaque, unavailable, uuid};
use crate::error::{ApiError, Result, only_fields};
use serde_json::Value;
use std::collections::HashSet;
pub(crate) fn revision(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(crate) fn safe_name(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|v| {
        !v.trim().is_empty() && v.encode_utf16().count() <= max && !v.chars().any(char::is_control)
    })
}
pub(crate) fn tool_name(v: &Value) -> bool {
    v.as_str().is_some_and(|v| {
        !v.is_empty()
            && v.len() <= 128
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:/-".contains(&b))
    })
}
pub(crate) fn validate_grants(share: &Share) -> Result<()> {
    if let Some(files) = &share.files {
        if files.len() > 32 {
            return Err(unavailable());
        }
        let mut ids = HashSet::new();
        let mut bytes = 0;
        for f in files {
            only_fields(f, &["fileId", "revision", "name", "size", "type"])
                .map_err(|_| unavailable())?;
            if !f["fileId"].as_str().is_some_and(opaque)
                || !ids.insert(f["fileId"].clone().to_string())
                || !revision(&f["revision"])
                || !safe_name(&f["name"], 4096)
                || f["name"]
                    .as_str()
                    .is_some_and(|v| v.contains('/') || v.contains('\\'))
                || !f["size"].as_u64().is_some_and(|v| v <= 10 * 1024 * 1024)
                || !f["type"]
                    .as_str()
                    .is_some_and(|v| v.len() <= 200 && !v.chars().any(char::is_control))
            {
                return Err(unavailable());
            }
            bytes += f["size"].as_u64().unwrap();
        }
        if bytes > 50 * 1024 * 1024 {
            return Err(unavailable());
        }
    }
    if let Some(apps) = &share.apps {
        if apps.len() > 20 || serde_json::to_vec(apps).unwrap_or_default().len() > 512 * 1024 {
            return Err(unavailable());
        }
        let mut ids = HashSet::new();
        for app in apps {
            only_fields(
                app,
                &["connectionId", "connectionRevision", "name", "tools"],
            )
            .map_err(|_| unavailable())?;
            if !app["connectionId"].as_str().is_some_and(uuid)
                || !app["connectionRevision"].as_str().is_some_and(uuid)
                || !ids.insert(app["connectionId"].clone().to_string())
                || !safe_name(&app["name"], 80)
            {
                return Err(unavailable());
            }
            let tools = app["tools"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 64)
                .ok_or_else(unavailable)?;
            let mut names = HashSet::new();
            for tool in tools {
                only_fields(tool, &["name", "revision"]).map_err(|_| unavailable())?;
                if !tool_name(&tool["name"])
                    || !revision(&tool["revision"])
                    || !names.insert(tool["name"].clone().to_string())
                {
                    return Err(unavailable());
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn request_uuid(body: &Value, key: &str) -> Result<String> {
    body[key]
        .as_str()
        .filter(|v| uuid(v))
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad("请求或版本标识无效。"))
}
