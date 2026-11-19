use super::{
    Table, WorkspaceStore, access, groups, model, mutations, starter_bots, starter_skills, unread,
};
use crate::{
    db::State,
    error::{ApiError, Body, Result, only_fields},
};
use axum::{
    Json,
    extract::{Path, State as Extract},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

const BINDING: &str = "builtin-recruiter";
const PROFILE_FIELDS: [&str; 6] = [
    "name",
    "role",
    "description",
    "instructions",
    "avatar",
    "color",
];
// SHA-256 of the six exact profile fields in each released catalog.
const LEGACY_PROFILES: [(&str, &str); 4] = [
    // ca41ab8, before the dedicated recruiter entry.
    (
        "zh-CN",
        "aba904a9ce1a9650f9e0c3b0616be83e799fcb1661af651b877575e4a02dce7a",
    ),
    (
        "en",
        "22c33c62e910e8c747955c584f64f3c1256f05bcc2ed23a1e0b7222da6e1aff0",
    ),
    // b836a58 through the last BambooShift release.
    (
        "zh-CN",
        "86093cd6efe3a8f6f2efb2856201c0463fcb87203b8077bb2eb12e95758ad139",
    ),
    (
        "en",
        "e27ebe725d8f8c4bf1024ec750e4443b3cda6fba3067a714cd7397fe19413131",
    ),
];
fn profile(locale: &str) -> Value {
    starter_bots::profile("recruitment", locale).expect("The built-in recruiter translation exists")
}

fn direct(chat: &Value, agent: &Value) -> bool {
    chat["isGroup"] == false && chat["agentIds"] == json!([agent["id"]])
}

enum TemplateMatch {
    Current,
    Previous(&'static str),
}

fn prior_template(agent: &Value, profiles: &[Value; 2]) -> Option<TemplateMatch> {
    if agent.get("sharedBot").is_some() || !agent["avatarImageId"].is_null() {
        return None;
    }
    let fields = PROFILE_FIELDS.map(|k| &agent[k]);
    if profiles
        .iter()
        .any(|profile| PROFILE_FIELDS.map(|k| &profile[k]) == fields)
    {
        return Some(TemplateMatch::Current);
    }
    // Exact shipped profiles can be upgraded without overwriting customized prompts.
    let encoded = serde_json::to_vec(&fields).ok()?;
    let digest = hex::encode(Sha256::digest(encoded));
    LEGACY_PROFILES
        .iter()
        .find_map(|(locale, old)| (*old == digest).then_some(TemplateMatch::Previous(locale)))
}

async fn find_or_create(
    store: &WorkspaceStore,
    conn: &mut SqliteConnection,
    binding: &Value,
    locale: &str,
) -> Result<(Value, Value, bool)> {
    let agent = match binding["agentId"].as_str() {
        Some(id) => WorkspaceStore::get_in(conn, Table::Agents, id)
            .await?
            .filter(|agent| mutations::local(agent).is_ok()),
        None => None,
    };
    let profiles = [profile("zh-CN"), profile("en")];
    let (mut agent, matched) = if let Some(agent) = agent {
        let matched = prior_template(&agent, &profiles);
        (agent, matched)
    } else {
        let agents = WorkspaceStore::list_in(conn, Table::Agents).await?;
        let candidate = agents.into_iter().find_map(|agent| {
            let matched = prior_template(&agent, &profiles)?;
            Some((agent, Some(matched)))
        });
        let Some(candidate) = candidate else {
            let (agent, chat) = mutations::create_bot(store, conn, &profile(locale)).await?;
            let packs = starter_skills::bot("recruitment", locale)?;
            starter_skills::install(conn, &packs, &agent["id"]).await?;
            return Ok((agent, chat, true));
        };
        candidate
    };

    let remembered = match binding["conversationId"].as_str() {
        Some(id) => WorkspaceStore::get_in(conn, Table::Conversations, id)
            .await?
            .filter(|chat| direct(chat, &agent)),
        None => None,
    };
    let chat = match remembered {
        Some(chat) => Some(chat),
        None => WorkspaceStore::list_in(conn, Table::Conversations)
            .await?
            .into_iter()
            .find(|chat| direct(chat, &agent)),
    };
    let mut changed = false;
    let old_name = agent["name"].clone();
    if let Some(TemplateMatch::Previous(locale)) = matched {
        let updated = profile(locale);
        for key in PROFILE_FIELDS {
            agent[key] = updated[key].clone();
        }
        agent["configRevision"] = json!(uuid::Uuid::new_v4().to_string());
        WorkspaceStore::put_in(conn, Table::Agents, &agent).await?;
        changed = true;
    }
    let chat = match chat {
        Some(mut chat) => {
            if chat["title"] == old_name && agent["name"] != old_name {
                chat["title"] = agent["name"].clone();
                WorkspaceStore::put_in(conn, Table::Conversations, &chat).await?;
            }
            chat
        }
        None => {
            changed = true;
            groups::create_direct(conn, &agent).await?
        }
    };
    Ok((agent, chat, changed))
}

fn public_fields(value: Value, fields: &[&str]) -> Value {
    let Value::Object(mut data) = value else {
        return Value::Null;
    };
    data.retain(|field, _| fields.contains(&field.as_str()));
    Value::Object(data)
}

pub async fn post(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    Body(body): Body,
) -> Result<Json<Value>> {
    let grant = access::require(&state, &headers, &wid, true, true).await?;
    only_fields(&body, &["locale"])?;
    let locale = body["locale"]
        .as_str()
        .filter(|locale| matches!(*locale, "zh-CN" | "en"))
        .ok_or_else(|| ApiError::bad("招聘助理语言无效。").with_code("INVALID_RECRUITER_LOCALE"))?;
    let store = grant.store(&state).await?;
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.begin().await?;
    let prior = WorkspaceStore::get_in(&mut tx, Table::Settings, BINDING)
        .await?
        .unwrap_or_default();
    let (mut agent, mut conversation, changed) =
        find_or_create(&store, &mut tx, &prior, locale).await?;
    let binding = json!({
        "id":BINDING,"agentId":agent["id"],"conversationId":conversation["id"]
    });
    if binding != prior {
        WorkspaceStore::put_in(&mut tx, Table::Settings, &binding).await?;
    }
    agent["modelConfigured"] = json!(
        model::bot_configured_in(&store, &mut tx, agent["id"].as_str().unwrap_or(""))
            .await
            .unwrap_or(false)
    );
    unread::project(
        &mut tx,
        &grant.user_id,
        std::slice::from_mut(&mut conversation),
    )
    .await?;
    grant.authorize(&state).await?;
    tx.commit().await?;
    if changed {
        store.emit("update", json!({}));
    }
    grant.authorize(&state).await?;
    let agent = public_fields(
        agent,
        &[
            "id",
            "name",
            "role",
            "description",
            "instructions",
            "avatar",
            "color",
            "avatarImageId",
            "modelProfileId",
            "modelConfigured",
            "status",
            "configRevision",
        ],
    );
    let conversation = public_fields(
        conversation,
        &[
            "id",
            "title",
            "agentIds",
            "isGroup",
            "updatedAt",
            "unread",
            "readThrough",
            "pinned",
        ],
    );
    Ok(Json(json!({
        "agentId":agent["id"],"conversationId":conversation["id"],"agent":agent,"conversation":conversation
    })))
}
