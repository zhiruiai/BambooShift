use super::*;

fn skill(id: &str, content: &str) -> Value {
    json!({"id":id,"name":"发布复核","description":"Review a release","content":content,"version":3})
}

fn memory(id: &str, content: &str) -> Value {
    json!({"id":id,"agentId":"review-bot","content":content,"category":"context","createdAt":"2026-01-01T00:00:00Z"})
}

#[test]
fn small_prompt_retains_existing_format() {
    let skills = [skill("a", "Review changes.\nCJK 中文")];
    let memories = [memory("b", "Prefers short answers.")];
    let output = prompt(&skills, &memories, None);
    assert!(!output.lazy_skills && !output.lazy_memories);
    let exact_skills = json!([{"name":skills[0]["name"],"content":skills[0]["content"]}]);
    assert_eq!(
        output.text,
        format!("Saved memory data: [\"Prefers short answers.\"]\nApproved skills: {exact_skills}")
    );
}

#[test]
fn prompt_budgets_serialized_escapes_and_tells_how_to_load_each_section() {
    let skills: Vec<_> = (0..8)
        .map(|index| skill(&format!("skill-{index}"), &"X".repeat(16_000)))
        .collect();
    let memories: Vec<_> = (0..4)
        .map(|index| memory(&format!("memory-{index}"), &"\u{0001}".repeat(1000)))
        .collect();
    let output = prompt(&skills, &memories, None);
    assert!(output.lazy_skills && output.lazy_memories);
    assert!(output.text.contains("8 approved skills") && output.text.contains("4 records"));
    assert!(output.text.contains("recall") && output.text.contains("read_skill"));
    assert!(output.text.contains("Review a release"));
    assert!(!output.text.contains("XXXX") && output.text.len() < 9_000);
    assert!(!prompt(&skills, &[], None).lazy_memories);
}

#[test]
fn list_skills_pages_all_scoped_ids_without_including_instructions() {
    let skills: Vec<_> = (0..85)
        .rev()
        .map(|index| skill(&format!("s-{index:03}"), "FULL_BODY_MARKER"))
        .collect();
    let mut cursor = None;
    let mut ids = Vec::new();
    for _ in 0..3 {
        let mut args = json!({"query":"RELEASE"});
        if let Some(cursor) = cursor {
            args["cursor"] = json!(cursor);
        }
        let page = list_skills(&skills, &args).unwrap();
        assert_eq!(page["total"], 85);
        assert_eq!(page["matched"], 85);
        assert!(!page.to_string().contains("FULL_BODY_MARKER"));
        ids.extend(
            page["skills"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["id"].clone()),
        );
        cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    assert!(cursor.is_none());
    assert_eq!(
        ids,
        (0..85)
            .map(|i| json!(format!("s-{i:03}")))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        list_skills(&skills, &json!({"query":"missing"})).unwrap()["matched"],
        0
    );
}

#[test]
fn skill_reader_preserves_unicode_and_paginates_legacy_lengths() {
    let content = "x".repeat(15_999) + "🙂结尾";
    let skills = [skill("same-scope", &content)];
    let first = read_skill(&skills, &json!({"skillId":"same-scope"})).unwrap();
    assert_eq!(first["version"], 3);
    assert_eq!(first["nextOffset"], 15_999);
    let last = read_skill(
        &skills,
        &json!({"skillId":"same-scope","offset":first["nextOffset"]}),
    )
    .unwrap();
    assert_eq!(last["content"], "🙂结尾");
    assert!(last["nextOffset"].is_null());
    assert!(read_skill(&skills, &json!({"skillId":"same-scope","offset":16_000})).is_err());
    assert!(read_skill(&skills, &json!({"skillId":"another-scope"})).is_err());
    assert!(read_skill(&skills, &json!({"skillId":"same-scope","agentId":"other"})).is_err());
}

#[test]
fn recall_reaches_beyond_one_hundred_and_keeps_existing_fields() {
    let memories: Vec<_> = (0..105)
        .rev()
        .map(|index| memory(&format!("m-{index:03}"), "MEMORY needle"))
        .collect();
    let mut cursor = None;
    let mut ids = Vec::new();
    for _ in 0..4 {
        let mut args = json!({"query":"NEEDLE"});
        if let Some(cursor) = cursor {
            args["cursor"] = json!(cursor);
        }
        let page = recall(&memories, &args).unwrap();
        assert_eq!(page["total"], 105);
        assert_eq!(page["matched"], 105);
        for item in page["memories"].as_array().unwrap() {
            assert_eq!(item["agentId"], "review-bot");
            assert_eq!(item["content"], "MEMORY needle");
            assert_eq!(item["category"], "context");
            ids.push(item["id"].clone());
        }
        cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    assert!(cursor.is_none());
    assert_eq!(
        ids,
        (0..105)
            .map(|i| json!(format!("m-{i:03}")))
            .collect::<Vec<_>>()
    );
    assert!(recall(&memories, &json!({"workspaceId":"other"})).is_err());
}

#[test]
fn recall_bounds_escaped_bytes_and_paginates_a_legacy_record() {
    let content = "\u{0001}".repeat(5999) + "🙂记忆结尾";
    let memories = [
        memory("legacy:记忆", &content),
        memory("other", "Next memory"),
    ];
    let first = recall(&memories, &json!({})).unwrap();
    assert_eq!(first["memories"].as_array().unwrap().len(), 1);
    assert!(first.to_string().len() < 40_000);
    let second = recall(&memories, &json!({"cursor":first["nextCursor"]})).unwrap();
    assert_eq!(second["memories"][0]["content"], "🙂记忆结尾");
    assert_eq!(second["memories"][1]["content"], "Next memory");
    assert!(second["nextCursor"].is_null());
}
