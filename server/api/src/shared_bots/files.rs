use super::{
    resources,
    source::{SourceDatabase, Workspace},
    store::{opaque, sha, unavailable},
};
use crate::{
    db::State,
    error::{ApiError, Result, only_fields},
    workspace::file_storage::Directory,
};
use serde_json::{Value, json};
use std::path::Path;
const LIMIT: u64 = 10 * 1024 * 1024;
#[derive(Clone)]
pub(crate) struct UsedFile {
    workspace: Workspace,
    record: Value,
    stamp: String,
}
pub struct SharedFile {
    pub name: String,
    pub bytes: Vec<u8>,
}
fn fail(missing: bool) -> ApiError {
    if missing {
        ApiError::new(404, "来源文件已删除。").with_code("SHARED_FILE_MISSING")
    } else {
        ApiError::new(409, "来源内容已变化，等待拥有者确认新版本。")
            .with_code("SHARED_FILE_CHANGED")
    }
}
fn record(value: Value, id: &str) -> Result<Value> {
    let name = value["name"].as_str().ok_or_else(|| fail(false))?;
    if value["id"] != id
        || !opaque(id)
        || name.is_empty()
        || name.len() > 4096
        || name.contains('\\')
        || name.chars().any(char::is_control)
        || name.starts_with('/')
        || name
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || !value["size"].as_u64().is_some_and(|n| n <= LIMIT)
        || !value["type"]
            .as_str()
            .is_some_and(|v| v.len() <= 200 && !v.chars().any(char::is_control))
        || !value["createdAt"]
            .as_str()
            .is_some_and(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok())
    {
        return Err(fail(false));
    }
    Ok(
        json!({"fileId":id,"name":name,"size":value["size"],"type":value["type"],"createdAt":value["createdAt"]}),
    )
}
async fn registered(db: &mut SourceDatabase, id: &str) -> Result<Value> {
    if !opaque(id) {
        return Err(fail(false));
    }
    let data: Option<String> =
        sqlx::query_scalar("SELECT data FROM files WHERE id=? AND length(data)<=32768")
            .bind(id)
            .fetch_optional(&mut db.conn)
            .await?;
    record(
        serde_json::from_str(&data.ok_or_else(|| fail(true))?).map_err(|_| fail(false))?,
        id,
    )
}
pub(crate) async fn read(
    state: &State,
    workspace: &Workspace,
    id: &str,
    expected: Option<&str>,
) -> Result<(Value, SharedFile, UsedFile)> {
    let mut db = SourceDatabase::open(state, workspace).await?;
    let record = registered(&mut db, id).await?;
    let directory = Directory::open(&db.directory, false)?;
    let mut reader = directory.reader(record["name"].as_str().unwrap())?;
    if reader.len() > LIMIT {
        return Err(fail(false));
    }
    let stamp = reader.stamp()?;
    let mut bytes = Vec::with_capacity(reader.len() as usize);
    while let Some(chunk) = reader.next()? {
        bytes.extend(chunk);
    }
    let revision = sha(serde_json::to_vec(&json!([
        id,
        record["name"],
        record["type"],
        record["createdAt"],
        bytes.len(),
        sha(&bytes)
    ]))
    .unwrap());
    if expected.is_some_and(|v| v != revision) {
        return Err(fail(false));
    }
    let guard = UsedFile {
        workspace: workspace.clone(),
        record: record.clone(),
        stamp,
    };
    guard.authorize(state).await?;
    db.check()?;
    let name = Path::new(record["name"].as_str().unwrap())
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| fail(false))?
        .to_owned();
    let grant = json!({"fileId":id,"name":name,"size":bytes.len(),"type":record["type"],"revision":revision});
    Ok((grant, SharedFile { name, bytes }, guard))
}
impl UsedFile {
    pub async fn authorize(&self, state: &State) -> Result<()> {
        let mut db = SourceDatabase::open(state, &self.workspace).await?;
        if registered(&mut db, self.record["fileId"].as_str().unwrap()).await? != self.record {
            return Err(unavailable());
        }
        let current =
            Directory::open(&db.directory, false)?.reader(self.record["name"].as_str().unwrap())?;
        if current.stamp()? != self.stamp {
            return Err(unavailable());
        }
        db.check()?;
        Ok(())
    }
}
pub(crate) async fn select(
    state: &State,
    workspace: &Workspace,
    input: Option<&Value>,
    old: Option<&Vec<Value>>,
) -> Result<(Option<Vec<Value>>, Vec<UsedFile>)> {
    let Some(input) = input else {
        return Ok((old.cloned(), Vec::new()));
    };
    let entries = input
        .as_array()
        .filter(|v| v.len() <= 32)
        .ok_or_else(|| ApiError::bad("最多选择32份共享资料。"))?;
    let mut ids = std::collections::HashSet::new();
    let mut result = Vec::new();
    let mut size = 0;
    let mut guards = Vec::new();
    for entry in entries {
        only_fields(entry, &["fileId", "revision"])?;
        let id = entry["fileId"]
            .as_str()
            .filter(|v| opaque(v))
            .ok_or_else(|| ApiError::bad("文件标识无效。"))?;
        if !resources::revision(&entry["revision"]) || !ids.insert(id) {
            return Err(ApiError::bad("资料版本或重复选项无效。"));
        }
        let (grant, _, guard) = read(state, workspace, id, entry["revision"].as_str()).await?;
        size += grant["size"].as_u64().unwrap();
        if size > 50 * 1024 * 1024 {
            return Err(ApiError::new(413, "共享资料合计不能超过50MiB。"));
        }
        result.push(grant);
        guards.push(guard);
    }
    for guard in &guards {
        guard.authorize(state).await?;
    }
    result.sort_by(|a, b| a["fileId"].as_str().cmp(&b["fileId"].as_str()));
    Ok((Some(result), guards))
}
pub(crate) async fn views(state: &State, workspace: &Workspace, grants: &[Value]) -> Vec<Value> {
    let mut result = Vec::new();
    for grant in grants {
        let mut view = grant.clone();
        match read(
            state,
            workspace,
            grant["fileId"].as_str().unwrap_or(""),
            grant["revision"].as_str(),
        )
        .await
        {
            Ok((current, _, _)) if current == *grant => {
                view["status"] = json!("available");
            }
            Ok(_) => {
                view["status"] = json!("changed");
                view["reason"] = json!("来源内容已变化，等待拥有者确认新版本。");
            }
            Err(error) => {
                view["status"] = json!(if error.status.as_u16() == 404 {
                    "missing"
                } else if error.code == "SHARED_FILE_CHANGED" {
                    "changed"
                } else {
                    "unavailable"
                });
                view["reason"] = json!("来源资料已变化或暂不可用，请由拥有者核对。");
            }
        }
        result.push(view);
    }
    result
}
pub(crate) async fn options(
    state: &State,
    workspace: &Workspace,
    grants: &[Value],
    query: &str,
) -> Result<Value> {
    if query.encode_utf16().count() > 120 {
        return Err(ApiError::bad("搜索关键词不能超过120个字符。"));
    }
    let mut db = SourceDatabase::open(state, workspace).await?;
    let rows=sqlx::query_as::<_,(String,String)>("SELECT id,data FROM files WHERE instr(lower(json_extract(data,'$.name')),?)>0 ORDER BY json_extract(data,'$.name'),id LIMIT 201").bind(query.trim().to_lowercase()).fetch_all(&mut db.conn).await?;
    let mut values = Vec::new();
    for (id, data) in rows.iter().take(200) {
        if let Ok(mut value) = serde_json::from_str::<Value>(data)
            .map_err(|_| fail(false))
            .and_then(|v| record(v, id))
        {
            let name = Path::new(value["name"].as_str().unwrap())
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            value["name"] = json!(name);
            value.as_object_mut().unwrap().remove("createdAt");
            values.push(value);
        }
    }
    db.check()?;
    Ok(
        json!({"files":values,"selected":views(state,workspace,grants).await,"truncated":rows.len()>200}),
    )
}
