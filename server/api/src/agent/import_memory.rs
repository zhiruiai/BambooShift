use super::{authority::ExecutionAccess, registry::ActiveRun, tools::check_fence};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result, only_fields},
    workspace::{Table, WorkspaceStore},
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

pub(crate) fn definition() -> Value {
    json!({"name":"remember","description":"Save distilled stable facts in one atomic batch. Prefer {memories:[{content,category?},...]} (1–20 entries), then summarize. Legacy {content,category?} saves one entry. Supply memories OR content. The entire import allows 40 entries and 24000 UTF-16 characters; one entry allows 4000 characters.","parameters":{"type":"object","properties":{"memories":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","properties":{"content":{"type":"string"},"category":{"type":"string","enum":["preference","context","learning"]}},"required":["content"]}},"content":{"type":"string"},"category":{"type":"string","enum":["preference","context","learning"]}}}})
}
pub(crate) async fn remember(
    state: &State,
    grant: &ExecutionAccess,
    store: &WorkspaceStore,
    active: &ActiveRun,
    generation: u64,
    args: &Value,
) -> Result<Value> {
    only_fields(args, &["memories", "content", "category"])?;
    let rows = if let Some(memories) = args.get("memories") {
        if args.get("content").is_some() || args.get("category").is_some() {
            return Err(ApiError::bad("批量记忆和单条记忆参数不能同时提供。"));
        }
        memories
            .as_array()
            .filter(|m| !m.is_empty() && m.len() <= 20)
            .cloned()
            .ok_or_else(|| ApiError::bad("每批需要1至20条记忆。"))?
    } else {
        vec![args.clone()]
    };
    let mut checked = vec![];
    let mut characters = 0usize;
    for row in rows {
        only_fields(&row, &["content", "category"])?;
        let raw = row["content"]
            .as_str()
            .filter(|s| {
                !s.trim().is_empty() && !s.contains('\0') && s.encode_utf16().count() <= 4000
            })
            .ok_or_else(|| ApiError::bad("每条记忆需要1至4000个字符。"))?;
        let content = raw.trim();
        let category = row["category"].as_str().unwrap_or("context");
        if !["preference", "context", "learning"].contains(&category) {
            return Err(ApiError::bad("记忆分类无效。"));
        }
        characters += content.encode_utf16().count();
        checked.push((content.to_owned(), category.to_owned()));
    }
    if active.memory_writes.load(Ordering::Acquire) + checked.len() > 40
        || active.memory_characters.load(Ordering::Acquire) + characters > 24000
    {
        return Err(ApiError::new(429, "此次导入的记忆预算已达上限。"));
    }
    grant.authorize(state).await?;
    check_fence(active, generation)?;
    let mut tx = store.begin().await?;
    let mut saved = vec![];
    for (content, category) in checked {
        let memory = json!({"id":uuid::Uuid::new_v4().to_string(),"agentId":active.agent_id,"content":content,"category":category,"createdAt":iso(now())});
        WorkspaceStore::put_in(&mut tx, Table::Memories, &memory).await?;
        saved.push(memory);
    }
    grant.authorize(state).await?;
    check_fence(active, generation)?;
    tx.commit().await?;
    active
        .memory_writes
        .fetch_add(saved.len(), Ordering::AcqRel);
    active
        .memory_characters
        .fetch_add(characters, Ordering::AcqRel);
    store.emit("update", json!({}));
    let output = json!({"saved":saved.len(),"memories":saved});
    Ok(json!({"content":[{"type":"text","text":output.to_string()}],"details":output}))
}
