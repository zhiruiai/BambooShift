use super::{Table, WorkspaceStore, access, mutations};
use crate::{
    db::{State, iso, now},
    error::{ApiError, Body, Result},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

pub async fn add_memory(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    crate::error::only_fields(&body, &["agentId", "content", "category"])?;
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    mutations::find(
        &mut tx,
        Table::Agents,
        body["agentId"].as_str().unwrap_or(""),
    )
    .await?;
    let category = body["category"].as_str().unwrap_or("context");
    if !["preference", "context", "learning"].contains(&category) {
        return Err(ApiError::bad("记忆分类无效。"));
    }
    let value = json!({"id":uuid::Uuid::new_v4().to_string(),"agentId":body["agentId"],"content":crate::error::text(&body["content"],"记忆",4000)?,"category":category,"createdAt":iso(now())});
    WorkspaceStore::put_in(&mut tx, Table::Memories, &value).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok((StatusCode::CREATED, Json(value)))
}
pub async fn edit_memory(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    crate::error::only_fields(&body, &["content", "category"])?;
    let grant = access::require(&state, &headers, &wid, false, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let mut value = mutations::find(&mut tx, Table::Memories, &id).await?;
    if let Some(content) = body.get("content") {
        value["content"] = json!(crate::error::text(content, "记忆", 4000)?);
    }
    if let Some(category) = body.get("category") {
        if !category
            .as_str()
            .is_some_and(|c| ["preference", "context", "learning"].contains(&c))
        {
            return Err(ApiError::bad("记忆分类无效。"));
        }
        value["category"] = category.clone();
    }
    WorkspaceStore::put_in(&mut tx, Table::Memories, &value).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok(Json(value))
}
pub async fn delete_memory(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    delete(&state, &headers, &wid, &id, Table::Memories, false).await
}
pub async fn delete_skill(
    Extract(state): Extract<State>,
    Path((wid, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    delete(&state, &headers, &wid, &id, Table::Skills, true).await
}
async fn delete(
    state: &State,
    headers: &HeaderMap,
    wid: &str,
    id: &str,
    table: Table,
    owner: bool,
) -> Result<Json<Value>> {
    let grant = access::require(state, headers, wid, owner, true).await?;
    let store = grant.store(state).await?;
    let mut tx = store.begin().await?;
    let item = mutations::find(&mut tx, table, id).await?;
    if owner {
        let agent = mutations::find(
            &mut tx,
            Table::Agents,
            item["agentId"].as_str().unwrap_or(""),
        )
        .await?;
        mutations::local(&agent)?;
    }
    WorkspaceStore::delete_in(&mut tx, table, id).await?;
    grant.authorize(state).await?;
    tx.commit().await?;
    if owner {
        state.workspace.emit_all("update", json!({})).await;
    } else {
        store.emit("update", json!({}));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn add_skill(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>)> {
    crate::error::only_fields(
        &body,
        &["agentId", "name", "description", "content", "skillPackage"],
    )?;
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let agent = mutations::find(
        &mut tx,
        Table::Agents,
        body["agentId"].as_str().unwrap_or(""),
    )
    .await?;
    mutations::local(&agent)?;
    let value = stage_skill(&mut tx, &body, None).await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    store.emit("update", json!({}));
    Ok((StatusCode::CREATED, Json(value)))
}

pub(super) async fn stage_skill(
    conn: &mut SqliteConnection,
    body: &Value,
    team_source: Option<Value>,
) -> Result<Value> {
    let package = body
        .get("skillPackage")
        .map(|package| super::skill_packages::Package::parse(body, package))
        .transpose()?;
    let (name, description, content) = if let Some(package) = &package {
        (
            package.name.clone(),
            package.description.clone(),
            package.content.clone(),
        )
    } else {
        let description = body["description"].as_str().unwrap_or("");
        if description.encode_utf16().count() > 1000 {
            return Err(ApiError::bad("技能说明过长。"));
        }
        (
            crate::error::text(&body["name"], "技能名称", 100)?,
            description.to_owned(),
            crate::error::text(&body["content"], "技能内容", 16000)?,
        )
    };
    let version = WorkspaceStore::list_in(conn, Table::Skills)
        .await?
        .into_iter()
        .filter(|s| s["agentId"] == body["agentId"] && s["name"] == name)
        .filter_map(|s| s["version"].as_u64())
        .max()
        .unwrap_or(0);
    let id = uuid::Uuid::new_v4().to_string();
    let mut value = json!({"id":id,"agentId":body["agentId"],"name":name,"description":description,"content":content,"version":version+1,"status":"proposed","createdAt":iso(now())});
    if version > 0 {
        value["previousVersion"] = json!(version);
    }
    if let Some(source) = team_source {
        value["teamSource"] = source;
    }
    if let Some(package) = package {
        super::skill_packages::persist(conn, &mut value, package).await?;
    } else {
        super::skill_packages::persist_text(conn, &mut value).await?;
    }
    Ok(value)
}

pub(super) async fn activate_skill(
    conn: &mut SqliteConnection,
    skill: &mut Value,
    other_versions: &[Value],
    approve: bool,
) -> Result<()> {
    let at = iso(now());
    for old in other_versions {
        if old["agentId"] == skill["agentId"]
            && old["name"] == skill["name"]
            && old["status"] == "active"
        {
            let mut old = old.clone();
            old["status"] = json!("archived");
            old["deactivatedAt"] = json!(at);
            WorkspaceStore::put_in(conn, Table::Skills, &old).await?;
        }
    }
    skill["status"] = json!("active");
    skill["activatedAt"] = json!(at);
    if approve {
        skill["approvedAt"] = json!(at);
    }
    WorkspaceStore::put_in(conn, Table::Skills, skill).await?;
    Ok(())
}

pub async fn transition(
    Extract(state): Extract<State>,
    Path((wid, id, action)): Path<(String, String, String)>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    crate::error::only_fields(&body, &["expectedActiveId"])?;
    if !["approve", "restore", "disable"].contains(&action.as_str()) {
        return Err(ApiError::new(404, "技能操作不存在。"));
    }
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    let store = grant.store(&state).await?;
    let mut tx = store.begin().await?;
    let mut skill = mutations::find(&mut tx, Table::Skills, &id).await?;
    let agent = mutations::find(
        &mut tx,
        Table::Agents,
        skill["agentId"].as_str().unwrap_or(""),
    )
    .await?;
    mutations::local(&agent)?;
    let all = WorkspaceStore::list_in(&mut tx, Table::Skills).await?;
    let current = all.iter().find(|s| {
        s["agentId"] == skill["agentId"] && s["name"] == skill["name"] && s["status"] == "active"
    });
    if let Some(expected) = body.get("expectedActiveId") {
        if expected != &current.map(|s| s["id"].clone()).unwrap_or(Value::Null) {
            return Err(ApiError::new(409, "当前技能版本已变化。"));
        }
    }
    let valid = match action.as_str() {
        "approve" => skill["status"] == "proposed",
        "restore" => skill["status"] == "archived" || skill["status"] == "disabled",
        "disable" => skill["status"] == "active",
        _ => false,
    };
    if !valid {
        return Err(ApiError::new(409, "技能状态已变化，请重新查看。"));
    }
    if action == "disable" {
        skill["status"] = json!("disabled");
        skill["deactivatedAt"] = json!(iso(now()));
        WorkspaceStore::put_in(&mut tx, Table::Skills, &skill).await?;
    } else {
        activate_skill(&mut tx, &mut skill, &all, action == "approve").await?;
    }
    grant.authorize(&state).await?;
    tx.commit().await?;
    state.workspace.emit_all("update", json!({})).await;
    Ok(Json(skill))
}
