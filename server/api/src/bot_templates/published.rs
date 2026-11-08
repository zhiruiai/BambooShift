use super::{
    blueprint::{self, Snapshot},
    store,
};
use crate::{
    db::State,
    error::{ApiError, Result},
    sessions,
};
use axum::http::HeaderMap;
use serde_json::{Value, json};
use sqlx::Row;

pub(super) struct Publication {
    pub value: Value,
    pub snapshot: Snapshot,
}
pub(super) fn token(value: &str) -> Result<()> {
    if value.len() != 43
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(ApiError::new(404, "模板链接不存在或已撤销。"));
    }
    Ok(())
}
pub(super) async fn viewer(state: &State, headers: &HeaderMap) -> Result<Option<String>> {
    // An unrelated browser cookie cannot turn an anonymous preview into another account's team data.
    if !headers.contains_key("x-openbot-expected-user") {
        return Ok(None);
    }
    let identity =
        sessions::require(&mut *state.pool.acquire().await?, state, headers, "account").await?;
    Ok(Some(identity.user.id))
}
pub(super) async fn read(state: &State, link: &str, user: Option<&str>) -> Result<Publication> {
    state.bot_templates.ensure_open()?;
    token(link)?;
    let mut tx = state.bot_templates.pool.begin().await?;
    let entry=sqlx::query("SELECT l.template_id,l.version_id,t.workspace_id FROM template_links l JOIN templates t ON t.id=l.template_id WHERE l.token=? AND l.revoked=0").bind(link).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::new(404,"模板链接不存在或已撤销。"))?;
    let wid: String = entry.get("workspace_id");
    let id: String = entry.get("template_id");
    let version: String = entry.get("version_id");
    let stored = store::read(&mut tx, &wid, &id).await?;
    let publication = &stored.row["publication"];
    if publication["token"] != link || publication["versionId"] != version {
        return Err(ApiError::new(404, "模板链接不可用。"));
    }
    let kind =
        store::source_available(state, &wid, stored.row["createdBy"].as_str().unwrap()).await?;
    let policy = store::policy(&mut tx, &wid, &kind).await?;
    if policy["mode"] == "disabled"
        || publication["audience"] == "public" && policy["mode"] != "public"
    {
        return Err(ApiError::new(404, "模板链接不可用。"));
    }
    match publication["audience"].as_str() {
        Some("public") => {}
        Some("team") => {
            let user = user.ok_or_else(|| ApiError::new(401, "请登录具有访问权限的团队账户。"))?;
            let member:Option<i64>=sqlx::query_scalar("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.workspace_id=? AND u.status='active' AND w.status='active' AND w.kind='team'").bind(user).bind(&wid).fetch_optional(&state.pool).await?;
            if member.is_none() {
                return Err(ApiError::new(403, "你不具有这个团队模板的访问权限。"));
            }
        }
        _ => return Err(ApiError::new(404, "模板分享范围无效。")),
    }
    let row = sqlx::query(
        "SELECT data,avatar FROM template_versions WHERE id=? AND template_id=? AND workspace_id=?",
    )
    .bind(&version)
    .bind(&id)
    .bind(&wid)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::new(404, "模板版本不存在。"))?;
    let raw: Value = serde_json::from_str(row.get("data"))
        .map_err(|_| ApiError::new(409, "模板版本数据无效。"))?;
    let avatar: Option<Vec<u8>> = row.get("avatar");
    let blueprint = blueprint::validate(&raw["blueprint"], avatar.as_deref())?;
    if raw["digest"] != blueprint::hash(&blueprint) || raw["digest"] != publication["digest"] {
        return Err(ApiError::new(409, "模板版本校验失败。"));
    }
    let mut value = json!({"token":link,"revision":version,"digest":raw["digest"],"blueprint":blueprint,"audience":publication["audience"],"publishedAt":publication["publishedAt"]});
    if avatar.is_some() {
        value["avatarPath"] = json!(format!(
            "/api/bot-template-links/{link}/avatar?revision={version}"
        ));
    }
    tx.commit().await?;
    store::source_available(state, &wid, stored.row["createdBy"].as_str().unwrap()).await?;
    Ok(Publication {
        value,
        snapshot: Snapshot {
            blueprint,
            avatar,
            revision: version,
        },
    })
}
pub(super) async fn gallery(state: &State, user: Option<&str>, query: &str) -> Result<Value> {
    if query.encode_utf16().count() > 100 {
        return Err(ApiError::bad("模板搜索关键词过长。"));
    }
    let query = query.trim().to_lowercase();
    let mut result = Vec::new();
    let mut offset = 0;
    loop {
        let links=sqlx::query_scalar::<_,String>("SELECT l.token FROM template_links l JOIN templates t ON t.id=l.template_id WHERE l.revoked=0 ORDER BY json_extract(t.data,'$.publication.publishedAt') DESC,l.rowid DESC LIMIT 100 OFFSET ?").bind(offset).fetch_all(&state.bot_templates.pool).await?;
        let count = links.len();
        for link in links {
            let publication = match read(state, &link, user).await {
                Ok(p) => p,
                Err(e) if [401, 403, 404].contains(&e.status.as_u16()) => continue,
                Err(e) => return Err(e),
            };
            let profile = &publication.value["blueprint"]["profile"];
            if !query.is_empty()
                && !["name", "role", "description"]
                    .iter()
                    .map(|key| profile[key].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
                    .contains(&query)
            {
                continue;
            }
            let mut summary = json!({"token":link,"name":profile["name"],"role":profile["role"],"description":profile["description"],"avatar":profile["avatar"],"color":profile["color"],"audience":publication.value["audience"],"skillCount":publication.value["blueprint"]["skills"].as_array().unwrap().len(),"routineCount":publication.value["blueprint"]["routines"].as_array().unwrap().len(),"publishedAt":publication.value["publishedAt"]});
            if let Some(path) = publication.value.get("avatarPath") {
                summary["avatarPath"] = path.clone();
            }
            result.push(summary);
            if result.len() == 60 {
                return Ok(json!(result));
            }
        }
        if count < 100 {
            break;
        }
        offset += 100;
    }
    Ok(json!(result))
}
