use crate::{
    error::{ApiError, Result, only_fields, text},
    workspace::{knowledge, workflow_skills},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub(super) fn definitions() -> [Value; 2] {
    [
        json!({
            "name":"find_skills",
            "description":"Search the curated built-in Agent Skills library by task, name or identifier. Returns package provenance, license, compatibility requirements and resource paths. Available means listed, not installed or authorized. To install, direct the owner to the skill library; never claim this read-only lookup installed or executed a package. For external candidates use public research and verify the original repository and license.",
            "parameters":{"type":"object","additionalProperties":false,"properties":{
                "query":{"type":"string","maxLength":200},
                "language":{"type":"string","enum":["zh-CN","en"]},
                "offset":{"type":"integer","minimum":0}
            }}
        }),
        json!({
            "name":"propose_skill",
            "description":"Create a complete proposed Agent Skills package for this Bot, for the owner to inspect and enable. Supply the SKILL.md body in content plus actual supporting files as UTF-8 text. The server generates the YAML frontmatter and SKILL.md; do not include a second SKILL.md file. Include scripts, references or reusable assets, not just a description. The proposal never executes code, installs dependencies or grants tools. Preserve upstream license notices when adapting a package.",
            "parameters":{"type":"object","additionalProperties":false,"properties":{
                "name":{"type":"string","minLength":1,"maxLength":64},
                "description":{"type":"string","minLength":1,"maxLength":1024},
                "content":{"type":"string","minLength":1,"maxLength":16000},
                "license":{"type":"string","minLength":1,"maxLength":1024},
                "compatibility":{"type":"string","minLength":1,"maxLength":500},
                "files":{"type":"array","minItems":1,"maxItems":30,"items":{
                    "type":"object","additionalProperties":false,
                    "properties":{"path":{"type":"string","maxLength":320},"content":{"type":"string","maxLength":64000}},
                    "required":["path","content"]
                }}
            },"required":["name","description","content","files"]}
        }),
    ]
}

pub(super) fn find(args: &Value) -> Result<Value> {
    only_fields(args, &["query", "language", "offset"])?;
    let language = match args.get("language") {
        None => "zh-CN",
        Some(value) => value.as_str().ok_or_else(|| ApiError::bad("技能目录语言无效。"))?,
    };
    if !matches!(language, "zh-CN" | "en") {
        return Err(ApiError::bad("技能目录语言无效。"));
    }
    let query = args["query"].as_str().unwrap_or("");
    if query.chars().count() > 200 || args.get("query").is_some_and(|v| !v.is_string()) {
        return Err(ApiError::bad("技能检索词无效。"));
    }
    let offset = args
        .get("offset")
        .map_or(Some(0), Value::as_u64)
        .filter(|n| *n <= 10_000)
        .ok_or_else(|| ApiError::bad("技能目录分页无效。"))? as usize;
    let words = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let matches = workflow_skills::catalog(language)
        .iter()
        .filter(|item| {
            let haystack = format!(
                "{} {} {} {}",
                item["id"], item["name"], item["description"], item["content"]
            )
            .to_lowercase();
            words.iter().all(|word| haystack.contains(word))
        })
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    for item in matches.iter().skip(offset).take(8) {
        let body =
            workflow_skills::package(item["id"].as_str().unwrap_or(""), language, &Value::Null)?;
        let meta = &body["skillPackage"]["frontmatter"];
        let mut files = vec![json!("SKILL.md")];
        files.extend(
            body["skillPackage"]["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["path"].clone()),
        );
        entries.push(json!({"id":item["id"],"name":item["name"],"description":item["description"],
            "license":meta["license"],"source":meta["metadata"]["source"],"compatibility":meta["compatibility"],
            "files":files,"status":"available","installation":"owner-selects-in-skill-library"}));
    }
    Ok(json!({"items":entries,"matched":matches.len(),"nextOffset":
        (offset + entries.len() < matches.len()).then_some(offset + entries.len())}))
}

fn body(agent_id: &str, args: &Value) -> Result<Value> {
    only_fields(
        args,
        &[
            "name",
            "description",
            "content",
            "license",
            "compatibility",
            "files",
        ],
    )?;
    let files = args["files"]
        .as_array()
        .filter(|files| !files.is_empty() && files.len() <= 30)
        .ok_or_else(|| ApiError::bad("请为技能包提供至少一个实际的脚本、参考或资源文件。"))?;
    let mut encoded = Vec::new();
    let mut total = 0;
    for file in files {
        only_fields(file, &["path", "content"])?;
        let path = text(&file["path"], "技能文件路径", 320)?;
        let content = file["content"]
            .as_str()
            .filter(|value| value.len() <= 256 * 1024 && !value.contains('\0'))
            .ok_or_else(|| ApiError::bad("技能文件必须是有界的 UTF-8 文本。"))?;
        total += content.len();
        if total > 768 * 1024 {
            return Err(ApiError::bad("技能包资源总大小超出限制。"));
        }
        encoded.push(json!({"path":path,"base64":STANDARD.encode(content)}));
    }
    let mut frontmatter = json!({"metadata":{"created-with":"BambooShift"}});
    for key in ["license", "compatibility"] {
        if let Some(value) = args.get(key) {
            frontmatter[key] = value.clone();
        }
    }
    Ok(
        json!({"agentId":agent_id,"name":text(&args["name"],"技能名称",64)?,
        "description":text(&args["description"],"技能说明",1024)?,
        "content":text(&args["content"],"技能内容",16000)?,
        "skillPackage":{"root":args["name"],"frontmatter":frontmatter,"files":encoded}}),
    )
}

pub(super) async fn propose(
    conn: &mut SqliteConnection,
    agent_id: &str,
    args: &Value,
) -> Result<Value> {
    knowledge::stage_skill(conn, &body(agent_id, args)?, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{Table, WorkspaceStore};

    fn sample() -> Value {
        json!({"name":"revenue-check","description":"Check a synthetic revenue CSV.",
            "content":"Read references/checklist.md and run scripts/check.py only after approval.","license":"MIT",
            "files":[{"path":"scripts/check.py","content":"print('checked')\n"},
                {"path":"references/checklist.md","content":"Verify row totals and report missing amounts."}]})
    }

    #[tokio::test]
    async fn proposed_package_preserves_files_and_remains_disabled() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::open(directory.path()).await.unwrap();
        let agent = uuid::Uuid::new_v4().to_string();
        let mut tx = store.begin().await.unwrap();
        let skill = propose(&mut tx, &agent, &sample()).await.unwrap();
        assert_eq!(skill["status"], "proposed");
        assert!(skill["approvedAt"].is_null());
        assert_eq!(skill["skillPackage"]["format"], "agent-skills");
        assert_eq!(skill["skillPackage"]["files"].as_array().unwrap().len(), 3);
        let bytes: Vec<u8> = sqlx::query_scalar(
            "SELECT content FROM skill_package_files WHERE skill_id=? AND path='scripts/check.py'",
        )
        .bind(skill["id"].as_str().unwrap())
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(bytes, b"print('checked')\n");
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn invalid_names_paths_and_collisions_never_persist_a_proposal() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::open(directory.path()).await.unwrap();
        let agent = uuid::Uuid::new_v4().to_string();
        let before = store.list(Table::Skills).await.unwrap().len();
        for path in [
            "../outside.py",
            "/tmp/check.py",
            "scripts/../../outside.py",
            "SKILL.md",
            "scripts/Check.py",
        ] {
            let mut args = sample();
            args["files"][1]["path"] = json!(path);
            let mut tx = store.begin().await.unwrap();
            assert!(propose(&mut tx, &agent, &args).await.is_err(), "{path}");
            tx.rollback().await.unwrap();
        }
        let mut empty = sample();
        empty["files"] = json!([]);
        assert!(body(&agent, &empty).is_err());
        let mut invalid = sample();
        invalid["name"] = json!("Invalid Name");
        let mut tx = store.begin().await.unwrap();
        assert!(propose(&mut tx, &agent, &invalid).await.is_err());
        tx.rollback().await.unwrap();
        assert_eq!(store.list(Table::Skills).await.unwrap().len(), before);
    }

    #[test]
    fn catalog_reports_provenance_without_installing_or_executing() {
        let result = find(&json!({"query":"frontend-design","language":"en"})).unwrap();
        assert_eq!(result["matched"], 1);
        let item = &result["items"][0];
        assert_eq!(item["status"], "available");
        assert!(item["license"].as_str().unwrap().contains("Apache-2.0"));
        assert!(item["files"].as_array().unwrap().len() > 1);
        assert_eq!(
            find(&json!({"query":"nonexistent-synthetic-skill"})).unwrap()["matched"],
            0
        );
        assert!(find(&json!({"offset":-1})).is_err());
        assert!(find(&json!({"language":"invalid"})).is_err());
    }
}
