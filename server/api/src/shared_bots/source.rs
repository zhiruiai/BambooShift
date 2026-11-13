use super::store::{opaque, sha, unavailable, uuid};
use crate::{
    db::{State, storage::DatabaseFiles},
    error::Result,
    workspace::profiles,
};
use serde_json::{Value, json};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{path::PathBuf, time::Duration};

#[derive(Clone)]
pub(crate) struct Workspace {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub key: String,
}
pub(crate) struct SourceDatabase {
    pub conn: SqliteConnection,
    pub directory: PathBuf,
    files: DatabaseFiles,
}
pub(crate) struct Source {
    pub profile: Value,
    pub skills: Vec<Value>,
    pub revision: String,
    pub avatar: Option<Vec<u8>>,
}
pub(crate) async fn workspace(state: &State, wid: &str) -> Result<Workspace> {
    if !uuid(wid) {
        return Err(unavailable());
    }
    let row = sqlx::query(
        "SELECT id,name,kind,storage_key FROM workspaces WHERE id=? AND status='active'",
    )
    .bind(wid)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(unavailable)?;
    let result = Workspace {
        id: row.get("id"),
        name: row.get("name"),
        kind: row.get("kind"),
        key: row.get("storage_key"),
    };
    if result.key != "legacy" && result.key != result.id {
        return Err(unavailable());
    }
    Ok(result)
}
pub(crate) async fn member(state: &State, user: &str, wid: &str, owner: bool) -> Result<String> {
    let row=sqlx::query("SELECT u.name,m.role FROM users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=? AND u.status='active' AND w.id=? AND w.status='active'").bind(user).bind(wid).fetch_optional(&state.pool).await?.ok_or_else(unavailable)?;
    if owner && row.get::<String, _>("role") != "owner" {
        return Err(unavailable());
    }
    Ok(row.get("name"))
}
impl SourceDatabase {
    pub async fn open(state: &State, workspace: &Workspace) -> Result<Self> {
        let parents = if workspace.key == "legacy" {
            vec![]
        } else {
            vec!["spaces", workspace.id.as_str()]
        };
        let files = DatabaseFiles::open(&state.config.data_dir, &parents, "openbot.sqlite")
            .map_err(|_| unavailable())?;
        let directory = files.directory().to_owned();
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(files.path())
                .read_only(true)
                .create_if_missing(false)
                .busy_timeout(Duration::from_secs(1)),
        )
        .await
        .map_err(|_| unavailable())?;
        sqlx::query("PRAGMA query_only=ON")
            .execute(&mut conn)
            .await?;
        let result = Self {
            conn,
            directory,
            files,
        };
        result.check()?;
        Ok(result)
    }
    pub fn check(&self) -> Result<()> {
        self.files.check().map_err(|_| unavailable())
    }
    pub async fn exists(&mut self, table: &str) -> Result<bool> {
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        )
        .bind(table)
        .fetch_optional(&mut self.conn)
        .await?
        .is_some())
    }
    pub async fn agent(&mut self, id: &str) -> Result<Value> {
        if !opaque(id) {
            return Err(unavailable());
        }
        let data: Option<String> =
            sqlx::query_scalar("SELECT data FROM agents WHERE id=? AND length(data)<=100000")
                .bind(id)
                .fetch_optional(&mut self.conn)
                .await?;
        let value: Value =
            serde_json::from_str(&data.ok_or_else(unavailable)?).map_err(|_| unavailable())?;
        if value["id"] != id || value.get("sharedBot").is_some() {
            return Err(unavailable());
        }
        self.check()?;
        Ok(value)
    }
    pub async fn read(&mut self, id: &str) -> Result<Source> {
        sqlx::query("BEGIN").execute(&mut self.conn).await?;
        let agent = self.agent(id).await?;
        let mut profile = json!({});
        for key in [
            "name",
            "role",
            "description",
            "instructions",
            "avatar",
            "color",
        ] {
            if let Some(value) = agent.get(key) {
                profile[key] = value.clone();
            }
        }
        let profile = profiles::validate(&profile, false).map_err(|_| unavailable())?;
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT data FROM skills WHERE json_extract(data,'$.agentId')=?
             AND json_extract(data,'$.status')='active' AND json_type(data,'$.teamSource') IS NULL
             ORDER BY id LIMIT 65",
        )
        .bind(id)
        .fetch_all(&mut self.conn)
        .await?;
        if rows.len() > 64 || rows.iter().map(String::len).sum::<usize>() > 512 * 1024 {
            return Err(unavailable());
        }
        let mut names = std::collections::HashSet::new();
        let mut skills = Vec::new();
        for data in rows {
            let s: Value = serde_json::from_str(&data).map_err(|_| unavailable())?;
            if !s["id"].as_str().is_some_and(opaque)
                || s["agentId"] != id
                || s["status"] != "active"
                || !text(&s["name"], 100, false)
                || !text(&s["description"], 1000, true)
                || !text(&s["content"], 16000, false)
                || !names.insert(s["name"].clone().to_string())
                || !s["version"].as_u64().is_some_and(|v| v > 0)
                || !s["createdAt"]
                    .as_str()
                    .is_some_and(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok())
            {
                return Err(unavailable());
            }
            skills.push(json!({"id":s["id"],"agentId":id,"name":s["name"],"description":s["description"],"content":s["content"],"version":s["version"],"status":"active","createdAt":s["createdAt"]}));
        }
        let avatar = if let Some(image) = agent.get("avatarImageId").filter(|v| !v.is_null()) {
            let image = image.as_str().filter(|v| uuid(v)).ok_or_else(unavailable)?;
            let row=sqlx::query("SELECT data,bytes FROM avatar_assets WHERE id=? AND published=1 AND length(bytes)<=524288").bind(image).fetch_optional(&mut self.conn).await?.ok_or_else(unavailable)?;
            let metadata: Value = serde_json::from_str(row.get::<String, _>("data").as_str())
                .map_err(|_| unavailable())?;
            let bytes: Vec<u8> = row.get("bytes");
            if metadata["id"] != image
                || metadata["width"] != 512
                || metadata["height"] != 512
                || metadata["mimeType"] != "image/webp"
                || bytes.len() < 12
                || &bytes[..4] != b"RIFF"
                || &bytes[8..12] != b"WEBP"
            {
                return Err(unavailable());
            }
            Some(bytes)
        } else {
            None
        };
        sqlx::query("COMMIT").execute(&mut self.conn).await?;
        self.check()?;
        let revision = sha(serde_json::to_vec(
            &json!({"profile":profile,"skills":skills,"avatar":avatar.as_ref().map(sha)}),
        )
        .unwrap());
        Ok(Source {
            profile,
            skills,
            revision,
            avatar,
        })
    }
}
fn text(value: &Value, max: usize, empty: bool) -> bool {
    value.as_str().is_some_and(|s| {
        s.encode_utf16().count() <= max && !s.contains('\0') && (empty || !s.trim().is_empty())
    })
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod tests;
