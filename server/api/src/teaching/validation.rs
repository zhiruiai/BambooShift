use crate::{
    db::{iso, now},
    error::{ApiError, Result, only_fields},
};
use serde_json::{Value, json};
use std::collections::HashSet;
pub fn uuid(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| ApiError::bad("请求标识无效。"))
}
pub fn string(value: &Value, max: usize, empty: bool) -> Result<String> {
    let value = value
        .as_str()
        .ok_or_else(|| ApiError::bad("教学文字格式无效。"))?
        .trim();
    if (!empty && value.is_empty()) || value.encode_utf16().count() > max || value.contains('\0') {
        return Err(ApiError::bad("教学文字过长或为空。"));
    }
    Ok(value.into())
}
pub fn step(body: &Value) -> Value {
    let action = match body["type"].as_str().unwrap_or("") {
        "click" if body["button"] == "right" => "right_click",
        "click" if body["clickCount"] == 2 => "double_click",
        other => other,
    };
    let mut details = json!({});
    for key in ["x", "y", "toX", "toY", "deltaX", "deltaY"] {
        if body[key].is_number() {
            details[key] = body[key].clone();
        }
    }
    if action == "key" {
        let key = body["key"].as_str().unwrap_or("");
        if [
            "Enter",
            "Tab",
            "Escape",
            "Backspace",
            "Delete",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "ControlOrMeta+A",
        ]
        .contains(&key)
        {
            details["key"] = json!(key);
        }
    }
    // Arbitrary text, clipboard contents and printable keystrokes are never copied.
    if action == "navigate" {
        if let Some(raw) = body["url"].as_str() {
            if let Ok(url) = url::Url::parse(raw) {
                details["destination"] = json!(url.origin().ascii_serialization());
            }
        }
    }
    json!({"id":uuid::Uuid::new_v4().to_string(),"action":action,"details":details,"note":"","recordedAt":iso(now())})
}
pub fn review(saved: &Value, body: &Value) -> Result<Value> {
    only_fields(body, &["expectedRevision", "goal", "steps"])?;
    let goal = string(&body["goal"], 2000, true)?;
    let requested = body["steps"]
        .as_array()
        .filter(|s| s.len() <= 60)
        .ok_or_else(|| ApiError::bad("教学步骤过多或格式无效。"))?;
    let originals = saved["steps"]
        .as_array()
        .ok_or_else(|| ApiError::bad("教学记录格式无效。"))?;
    let mut used = HashSet::new();
    let mut result = Vec::new();
    let mut previous = None;
    for entry in requested {
        only_fields(entry, &["id", "note"])?;
        let id = uuid(&entry["id"])?;
        let index = originals
            .iter()
            .position(|s| s["id"] == id)
            .ok_or_else(|| ApiError::bad("只能编辑已记录的步骤说明。"))?;
        if !used.insert(id) || previous.is_some_and(|old| index <= old) {
            return Err(ApiError::bad("教学步骤重复或顺序已变化。"));
        }
        previous = Some(index);
        let mut step = originals[index].clone();
        step["note"] = json!(string(&entry["note"], 1000, true)?);
        result.push(step);
    }
    let mut value = saved.clone();
    value["goal"] = json!(goal);
    value["steps"] = json!(result);
    Ok(value)
}
pub fn proposal(raw: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(raw.trim())
        .map_err(|_| ApiError::bad("模型没有返回有效技能草稿。"))?;
    only_fields(&value, &["name", "description", "content"])?;
    Ok(
        json!({"name":string(&value["name"],100,false)?,"description":string(&value["description"],1000,false)?,"content":string(&value["content"],16000,false)?}),
    )
}
