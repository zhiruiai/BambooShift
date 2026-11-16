use super::{
    controller::Controller,
    model, screen_bindings,
    transport::{Authority, Target},
};
use crate::{
    error::{ApiError, Result, only_fields},
    workspace::{Table, WorkspaceStore, file_storage::Directory, skill_packages},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

pub(crate) const KIND: &str = "local_skill_script";
pub(crate) const CAPABILITY: &str = "local-skill-script-v1";
const INPUT_ARG: &str = "__SKILL_INPUT__";
const INPUT_MAX: usize = 256 * 1024;
const PACKAGE_MAX: usize = 1024 * 1024;

fn invalid() -> ApiError {
    ApiError::bad("技能脚本调用无效。").with_code("INVALID_SKILL_SCRIPT")
}

fn stale() -> ApiError {
    ApiError::new(409, "已审核的技能版本或所选文件已变化，请重新申请。")
        .with_code("SKILL_SCRIPT_SOURCE_CHANGED")
}

fn path_allowed(path: &str) -> bool {
    path.starts_with("scripts/")
        && (path.ends_with(".py") || path.ends_with(".mjs"))
        && skill_packages::valid_path(path)
}

pub(crate) fn has_script(skill: &Value) -> bool {
    skill["skillPackage"]["files"]
        .as_array()
        .is_some_and(|files| {
            files
                .iter()
                .any(|file| file["path"].as_str().is_some_and(path_allowed))
        })
}

pub(crate) async fn require_target(controller: &Controller, target: &Target) -> Result<()> {
    if target.saved.platform != "darwin"
        || !target.saved.has("local-shell-v1")
        || !target.saved.has(CAPABILITY)
        || !controller.is_local().await
        || screen_bindings::execution_location(controller, target).await != "server"
    {
        return Err(
            ApiError::new(409, "请在此 Mac 的桌面应用开启本机命令权限并更新执行器。")
                .with_code("SKILL_SCRIPT_LOCAL_REQUIRED"),
        );
    }
    Ok(())
}

fn fingerprint(package: &Value, path: &str) -> Result<String> {
    let root = package["root"]
        .as_str()
        .filter(|root| skill_packages::valid_path(root) && !root.contains('/'))
        .ok_or_else(stale)?;
    let manifest = package["files"]
        .as_array()
        .filter(|files| !files.is_empty() && files.len() <= 64)
        .ok_or_else(stale)?;
    let mut digest = Sha256::new();
    digest.update(b"bambooshift-skill-package-v1\n");
    digest.update(root.as_bytes());
    digest.update(b"\n");
    let mut previous: Option<&str> = None;
    let mut total = 0u64;
    let mut script = false;
    let mut skill_md = false;
    for file in manifest {
        let relative = file["path"]
            .as_str()
            .filter(|name| skill_packages::valid_path(name))
            .ok_or_else(stale)?;
        if previous.is_some_and(|previous| previous >= relative) {
            return Err(stale());
        }
        previous = Some(relative);
        script |= relative == path;
        skill_md |= relative == "SKILL.md";
        let sha = file["sha256"]
            .as_str()
            .filter(|sha| {
                sha.len() == 64
                    && sha
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or_else(stale)?;
        total += file["size"]
            .as_u64()
            .filter(|size| *size <= INPUT_MAX as u64)
            .ok_or_else(stale)?;
        digest.update(relative.as_bytes());
        digest.update(b"\0");
        digest.update(sha.as_bytes());
        digest.update(b"\n");
    }
    if package["format"] != "agent-skills" || !script || !skill_md || total > PACKAGE_MAX as u64 {
        return Err(stale());
    }
    Ok(hex::encode(digest.finalize()))
}

pub(crate) struct Prepared(Value);

impl Prepared {
    pub(super) fn into_payload(self) -> Value {
        self.0
    }
}

pub(crate) async fn prepare(
    store: &WorkspaceStore,
    agent: &str,
    conversation: &str,
    skills: &[Value],
    args: &Value,
) -> Result<Prepared> {
    only_fields(args, &["skillId", "path", "args", "fileId"]).map_err(|_| invalid())?;
    let id = args["skillId"]
        .as_str()
        .filter(|id| model::opaque(id))
        .ok_or_else(invalid)?;
    let path = args["path"]
        .as_str()
        .filter(|path| path_allowed(path))
        .ok_or_else(invalid)?;
    let argv = args["args"]
        .as_array()
        .filter(|argv| {
            argv.len() <= 16
                && argv.iter().all(|arg| {
                    arg.as_str()
                        .is_some_and(|arg| arg.len() <= 512 && !arg.chars().any(char::is_control))
                })
        })
        .ok_or_else(invalid)?;
    let input_id = args
        .get("fileId")
        .map(|id| {
            id.as_str()
                .filter(|id| model::opaque(id))
                .ok_or_else(invalid)
        })
        .transpose()?;
    if argv.iter().filter(|arg| *arg == INPUT_ARG).count() != usize::from(input_id.is_some()) {
        return Err(invalid());
    }
    let skill = skills
        .iter()
        .find(|skill| skill["id"] == id && skill["agentId"] == agent && skill["status"] == "active")
        .ok_or_else(stale)?;
    let name = skill["name"]
        .as_str()
        .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
        .ok_or_else(stale)?;
    let version = skill["version"]
        .as_u64()
        .filter(|version| *version > 0)
        .ok_or_else(stale)?;
    let sha = fingerprint(&skill["skillPackage"], path)?;
    let mut payload = json!({"type":KIND,"skillId":id,"skillName":name,"skillVersion":version,"manifestSha256":sha,"path":path,"args":argv});
    recheck(store, agent, &payload).await?;
    if let Some(input_id) = input_id {
        let (description, _) = read_input(store, conversation, input_id).await?;
        payload["input"] = description;
    }
    Ok(Prepared(payload))
}

async fn read_input(
    store: &WorkspaceStore,
    conversation: &str,
    id: &str,
) -> Result<(Value, Vec<u8>)> {
    let file = store
        .get(Table::Files, id)
        .await?
        .filter(|file| file["conversationId"] == conversation)
        .ok_or_else(stale)?;
    let path = file["name"].as_str().ok_or_else(stale)?;
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| {
            name.len() <= 240
                && name.to_ascii_lowercase().ends_with(".csv")
                && skill_packages::valid_path(name)
        })
        .ok_or_else(invalid)?;
    let mut reader = Directory::open(&store.directory, false)?.reader(path)?;
    if reader.len() > INPUT_MAX as u64 {
        return Err(ApiError::new(413, "技能脚本的 CSV 文件最大为 256 KiB。"));
    }
    let mut bytes = Vec::with_capacity(reader.len() as usize);
    while let Some(chunk) = reader.next()? {
        if bytes.len() + chunk.len() > INPUT_MAX {
            return Err(ApiError::new(413, "技能脚本的 CSV 文件最大为 256 KiB。"));
        }
        bytes.extend(chunk);
    }
    let sha = hex::encode(Sha256::digest(&bytes));
    Ok((
        json!({"fileId":id,"name":name,"sha256":sha,"bytes":bytes.len()}),
        bytes,
    ))
}

fn validate_live(skill: &Value, agent: &str, payload: &Value) -> Result<()> {
    if skill["id"] != payload["skillId"]
        || skill["agentId"] != agent
        || skill["status"] != "active"
        || skill["name"] != payload["skillName"]
        || skill["version"] != payload["skillVersion"]
        || fingerprint(
            &skill["skillPackage"],
            payload["path"].as_str().ok_or_else(stale)?,
        )? != payload["manifestSha256"]
    {
        return Err(stale());
    }
    Ok(())
}

pub(super) async fn recheck(store: &WorkspaceStore, agent: &str, payload: &Value) -> Result<()> {
    let id = payload["skillId"].as_str().ok_or_else(stale)?;
    let skill = store.get(Table::Skills, id).await?.ok_or_else(stale)?;
    validate_live(&skill, agent, payload)
}

pub(super) fn bind(
    authorize: Authority,
    store: Arc<WorkspaceStore>,
    agent: String,
    payload: &Value,
) -> Authority {
    let payload = Arc::new(payload.clone());
    Arc::new(move || {
        let (authorize, store, agent, payload) = (
            authorize.clone(),
            store.clone(),
            agent.clone(),
            payload.clone(),
        );
        Box::pin(async move {
            authorize().await?;
            recheck(&store, &agent, &payload).await
        })
    })
}

pub(super) async fn worker_payload(
    store: &WorkspaceStore,
    agent: &str,
    conversation: &str,
    payload: &Value,
) -> Result<Value> {
    let id = payload["skillId"].as_str().ok_or_else(stale)?;
    let mut tx = store.pool.begin().await?;
    let skill = WorkspaceStore::get_in(&mut tx, Table::Skills, id)
        .await?
        .ok_or_else(stale)?;
    validate_live(&skill, agent, payload)?;
    let files = skill_packages::verified_files(&mut tx, id, &skill["skillPackage"])
        .await
        .map_err(|_| stale())?;
    tx.commit().await?;
    let files = files.into_iter().zip(skill["skillPackage"]["files"].as_array().ok_or_else(stale)?)
        .map(|((path, bytes), file)| json!({"path":path,"base64":STANDARD.encode(bytes),"sha256":file["sha256"]}))
        .collect::<Vec<_>>();
    let mut output = json!({"type":KIND,"path":payload["path"],"args":payload["args"],"package":{
        "root":skill["skillPackage"]["root"],"manifestSha256":payload["manifestSha256"],"files":files
    }});
    if let Some(approved) = payload.get("input") {
        let (description, bytes) = read_input(
            store,
            conversation,
            approved["fileId"].as_str().ok_or_else(stale)?,
        )
        .await?;
        if description != *approved {
            return Err(stale());
        }
        output["input"] = json!({"name":description["name"],"sha256":description["sha256"],"base64":STANDARD.encode(bytes)});
    }
    Ok(output)
}
