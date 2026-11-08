#![allow(dead_code)]
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use openbot_backend::{config::Config, db::State};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::net::SocketAddr;
use tower::ServiceExt;

pub struct Fixture {
    pub directory: tempfile::TempDir,
    pub state: State,
    pub db: SqlitePool,
    pub owner: String,
    pub member: String,
    pub workspace: String,
    pub foreign: String,
    pub owner_token: String,
    pub member_token: String,
    pub operator_token: String,
}
impl Fixture {
    pub async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = State::open(Config::local(directory.path())).await.unwrap();
        let db = SqlitePool::connect(&format!(
            "sqlite:{}",
            directory.path().join("platform/identity.sqlite").display()
        ))
        .await
        .unwrap();
        let owner = uuid::Uuid::new_v4().to_string();
        let member = uuid::Uuid::new_v4().to_string();
        let workspace = uuid::Uuid::new_v4().to_string();
        let foreign = uuid::Uuid::new_v4().to_string();
        for (id, email, role) in [
            (&owner, "owner@example.test", "admin"),
            (&member, "member@example.test", "user"),
        ] {
            sqlx::query("INSERT INTO users VALUES(?,?,?,'synthetic-only','active',?,1)")
                .bind(id)
                .bind(email)
                .bind(email)
                .bind(role)
                .execute(&db)
                .await
                .unwrap();
        }
        for wid in [&workspace, &foreign] {
            sqlx::query("INSERT INTO workspaces VALUES(?,'Synthetic','team','active',?,1)")
                .bind(wid)
                .bind(wid)
                .execute(&db)
                .await
                .unwrap();
        }
        for (user, wid, role) in [
            (&owner, &workspace, "owner"),
            (&member, &workspace, "member"),
            (&member, &foreign, "owner"),
        ] {
            sqlx::query("INSERT INTO memberships VALUES(?,?,?,1)")
                .bind(wid)
                .bind(user)
                .bind(role)
                .execute(&db)
                .await
                .unwrap();
        }
        let owner_token = "o".repeat(43);
        let member_token = "m".repeat(43);
        let operator_token = "p".repeat(43);
        for (user, token, purpose) in [
            (&owner, &owner_token, "account"),
            (&member, &member_token, "account"),
            (&owner, &operator_token, "operator"),
        ] {
            sqlx::query("INSERT INTO account_sessions VALUES(?,?,?,?, 'Synthetic',1,?)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(hex::encode(Sha256::digest(token.as_bytes())))
                .bind(user)
                .bind(purpose)
                .bind(chrono::Utc::now().timestamp_millis() + 86_400_000)
                .execute(&db)
                .await
                .unwrap();
        }
        Self {
            directory,
            state,
            db,
            owner,
            member,
            workspace,
            foreign,
            owner_token,
            member_token,
            operator_token,
        }
    }
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        member: bool,
        expected: Option<&str>,
    ) -> (u16, Value) {
        self.with_cookie(
            method,
            path,
            body,
            &format!(
                "openbot_account={}",
                if member {
                    &self.member_token
                } else {
                    &self.owner_token
                }
            ),
            expected,
        )
        .await
    }
    pub async fn with_cookie(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        cookie: &str,
        expected: Option<&str>,
    ) -> (u16, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "127.0.0.1:3002")
            .header("origin", "http://127.0.0.1:3002")
            .header("cookie", cookie)
            .header("content-type", "application/json");
        if let Some(user) = expected {
            request = request.header("x-openbot-expected-user", user);
        }
        let mut request = request
            .body(
                body.map(|v| Body::from(v.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:41321".parse::<SocketAddr>().unwrap(),
        ));
        let response = openbot_backend::router(self.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or(json!({"invalid":String::from_utf8_lossy(&bytes)}));
        (status, value)
    }
    pub fn path(&self, suffix: &str) -> String {
        format!("/api/workspaces/{}{}", self.workspace, suffix)
    }
    pub async fn bootstrap(&self) -> Value {
        let (status, body) = self
            .request(
                "GET",
                &self.path("/bootstrap"),
                None,
                false,
                Some(&self.owner),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }
    pub async fn close(self) {
        self.db.close().await;
        self.state.close().await;
    }
}
