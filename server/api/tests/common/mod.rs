#![allow(dead_code)]
use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use http_body_util::BodyExt;
use openbot_backend::{config::Config, db::State, router};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use tempfile::TempDir;
use tower::ServiceExt;

pub struct Fixture {
    pub directory: TempDir,
    pub state: State,
    pub app: Router,
}
pub struct Reply {
    pub status: u16,
    pub value: Value,
    pub headers: HeaderMap,
}
impl Reply {
    pub fn cookie(&self) -> String {
        self.headers
            .get_all("set-cookie")
            .iter()
            .map(|h| h.to_str().unwrap().split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ")
    }
}
impl Fixture {
    pub async fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let state = State::open(Config::local(directory.path())).await.unwrap();
        let app = router(state.clone());
        Self {
            directory,
            state,
            app,
        }
    }
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        body: Option<Value>,
    ) -> Reply {
        request(&self.app, method, path, cookie, body, &[]).await
    }
    pub async fn register(&self, email: &str, team: bool) -> Reply {
        let result=self.request("POST","/api/account/register","",Some(json!({"email":email,"name":"合成用户","password":"fixture-password-42","kind":if team{"team"}else{"personal"},"teamName":"合成团队"}))).await;
        assert_eq!(result.status, 201, "{}", result.value);
        result
    }
    pub async fn admin(&self) -> Reply {
        let path = self.state.provision_operator().await.unwrap();
        let code = std::fs::read_to_string(path).unwrap();
        let result=self.request("POST","/api/platform/setup","",Some(json!({"code":code.trim(),"email":"admin@example.test","name":"运营员","password":"fixture-password-42"}))).await;
        assert_eq!(result.status, 201, "{}", result.value);
        result
    }
    pub async fn database(&self) -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&format!(
                "sqlite://{}",
                self.directory
                    .path()
                    .join("platform/identity.sqlite")
                    .display()
            ))
            .await
            .unwrap()
    }
}
pub async fn request(
    app: &Router,
    method: &str,
    path: &str,
    cookie: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> Reply {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3002");
    if !cookie.is_empty() {
        builder = builder.header("cookie", cookie);
    }
    for (key, value) in headers {
        builder = builder.header(*key, *value);
    }
    let raw = body.map(|v| v.to_string()).unwrap_or_default();
    if !raw.is_empty() {
        builder = builder.header("content-type", "application/json");
    }
    let mut request = builder.body(Body::from(raw)).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("non-JSON response {status}"))
    };
    Reply {
        status,
        value,
        headers,
    }
}
