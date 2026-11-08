use super::{
    model,
    transport::{Authority, Request, Target},
    validation,
};
use crate::{
    db::{iso, now},
    error::{ApiError, Result},
    workspace::{Table, WorkspaceStore, file_storage::Directory},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub async fn inspect(store: &WorkspaceStore, payload: &mut Value) -> Result<()> {
    if payload["type"] != "upload_file" {
        return Ok(());
    }
    let (file, bytes) = read(
        store,
        payload["fileId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("请选择资料库文件。"))?,
    )
    .await?;
    let name = file["name"].as_str().unwrap_or("file");
    let basename = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    payload["path"] = json!(validation::path(&payload["path"], Some(basename))?);
    payload["sourceName"] = file["name"].clone();
    payload["size"] = json!(bytes.len());
    payload["sha256"] = json!(hex::encode(Sha256::digest(&bytes)));
    Ok(())
}
async fn read(store: &WorkspaceStore, id: &str) -> Result<(Value, Vec<u8>)> {
    let file = store
        .get(Table::Files, id)
        .await?
        .ok_or_else(|| ApiError::new(404, "资料库文件已不可用。"))?;
    let name = file["name"]
        .as_str()
        .ok_or_else(|| ApiError::new(409, "文件记录无效。"))?;
    let mut reader = Directory::open(&store.directory, false)?.reader(name)?;
    if reader.len() > model::MAX_FILE as u64 {
        return Err(ApiError::new(413, "文件最大为 10 MiB。"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reader.next()? {
        bytes.extend_from_slice(&chunk);
    }
    Ok((file, bytes))
}
pub async fn execute(
    store: &WorkspaceStore,
    target: &Arc<Target>,
    payload: &Value,
    conversation: Option<&str>,
    agent: Option<&str>,
    authorize: Authority,
) -> Result<Value> {
    if !target
        .saved
        .capabilities
        .iter()
        .any(|c| c == "binary-file-transfer")
    {
        return Err(ApiError::new(
            409,
            "工作电脑尚不支持文件传输，请升级后重新连接。",
        ));
    }
    authorize().await?;
    let path = validation::path(&payload["path"], None)?;
    let encoded: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
    let endpoint = format!("/files/content?path={encoded}");
    if payload["type"] == "upload_file" {
        let (file, bytes) = read(store, payload["fileId"].as_str().unwrap_or("")).await?;
        let hash = hex::encode(Sha256::digest(&bytes));
        if file["name"] != payload["sourceName"]
            || payload["size"] != bytes.len()
            || payload["sha256"] != hash
        {
            return Err(ApiError::new(
                409,
                "来源文件在批准前后发生变化，请重新申请。",
            ));
        }
        let mut request = Request::get(endpoint);
        request.method = reqwest::Method::PUT;
        request.content_type = "application/octet-stream";
        request.body = bytes;
        let receipt = target.request(request, authorize.clone()).await?.json()?;
        if receipt["path"] != path || receipt["size"] != payload["size"] {
            return Err(model::invalid());
        }
        authorize().await?;
        return Ok(
            json!({"path":path,"name":std::path::Path::new(&path).file_name().and_then(|v|v.to_str()),"size":payload["size"],"sha256":hash}),
        );
    }
    let mut request = Request::get(endpoint);
    request.max_bytes = model::MAX_FILE;
    let reply = target.request(request, authorize.clone()).await?;
    if reply
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        != Some("application/octet-stream")
    {
        return Err(model::invalid());
    }
    authorize().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let proposed = std::path::Path::new(&path)
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| ApiError::bad("文件名称无效。"))?;
    let mut tx = store.begin().await?;
    if let Some(cid) = conversation {
        WorkspaceStore::get_in(&mut tx, Table::Conversations, cid)
            .await?
            .ok_or_else(|| ApiError::new(404, "会话已不可用。"))?;
    }
    if let Some(agent) = agent {
        WorkspaceStore::get_in(&mut tx, Table::Agents, agent)
            .await?
            .ok_or_else(|| ApiError::new(404, "Bot 已不可用。"))?;
    }
    let directory = Directory::open(&store.directory, true)?;
    let (name, uploaded) = directory.upload(proposed, &reply.bytes, &id)?;
    let mut file = json!({"id":id,"name":name,"size":reply.bytes.len(),"type":"application/octet-stream","createdAt":iso(now()),"source":{"kind":"computer","computerName":target.saved.name,"path":path,"importedAt":iso(now())}});
    if let Some(cid) = conversation {
        file["conversationId"] = json!(cid);
    }
    WorkspaceStore::put_in(&mut tx, Table::Files, &file).await?;
    authorize().await?;
    tx.commit().await?;
    uploaded.commit();
    store.emit("update", json!({}));
    Ok(
        json!({"fileId":id,"name":name,"size":reply.bytes.len(),"path":path,"sha256":hex::encode(Sha256::digest(&reply.bytes)),"url":format!("/api/workspaces/{}/files/{id}/download",store.workspace_id)}),
    )
}
