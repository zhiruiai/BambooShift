use crate::db::iso;
use serde_json::{Value, json};
use sqlx::FromRow;

#[derive(Clone, FromRow)]
pub(crate) struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub password_hash: String,
    pub status: String,
    pub platform_role: String,
    pub created_at: i64,
}
impl User {
    pub fn public(&self) -> Value {
        json!({"id":self.id,"email":self.email,"name":self.name,"status":self.status,"createdAt":iso(self.created_at)})
    }
}
#[derive(Clone, FromRow)]
pub(crate) struct Workspace {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub created_at: i64,
    pub role: String,
}
impl Workspace {
    pub fn public(&self) -> Value {
        json!({"id":self.id,"name":self.name,"kind":self.kind,"role":self.role,"status":self.status,"createdAt":iso(self.created_at)})
    }
}
pub(crate) struct Identity {
    pub user: User,
    pub session_id: String,
}
