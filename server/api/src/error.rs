use axum::{
    Json,
    extract::{FromRequest, Request},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub code: &'static str,
}
pub type Result<T> = std::result::Result<T, ApiError>;
impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        let code = match status {
            400 => "BAD_REQUEST",
            401 => "UNAUTHENTICATED",
            403 => "FORBIDDEN",
            404 => "NOT_FOUND",
            405 => "METHOD_NOT_ALLOWED",
            409 => "CONFLICT",
            410 => "GONE",
            413 => "PAYLOAD_TOO_LARGE",
            422 => "INVALID_INPUT",
            429 => "RATE_LIMITED",
            503 => "UNAVAILABLE",
            _ => "INTERNAL_ERROR",
        };
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.into(),
            code,
        }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
    pub fn with_code(mut self, code: &'static str) -> Self {
        self.code = code;
        self
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": self.message,"code":self.code})),
        )
            .into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::new(500, "账户数据暂不可用，请稍后重试。")
    }
}
impl From<std::io::Error> for ApiError {
    fn from(_: std::io::Error) -> Self {
        Self::new(500, "账户存储暂不可用。")
    }
}
pub struct Body(pub Value);
impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self> {
        let Json(value) = Json::<Value>::from_request(req, state).await.map_err(|e| {
            if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                ApiError::new(413, "请求内容过大。")
            } else {
                ApiError::new(400, "请求内容不是有效的 JSON。")
            }
        })?;
        Ok(Self(value))
    }
}
pub fn text(value: &Value, label: &str, max: usize) -> Result<String> {
    let s = value.as_str().unwrap_or("").trim();
    if s.is_empty() || s.encode_utf16().count() > max {
        return Err(ApiError::bad(format!(
            "{label}不能为空，且不能超过 {max} 个字符。"
        )));
    }
    Ok(s.to_owned())
}
pub fn email(value: &Value) -> Result<String> {
    let s = text(value, "邮箱", 254)?.to_lowercase();
    let parts: Vec<_> = s.split('@').collect();
    if parts.len() != 2
        || parts[0].is_empty()
        || !parts[1].contains('.')
        || parts[1].starts_with('.')
        || parts[1].ends_with('.')
        || s.chars().any(char::is_whitespace)
    {
        return Err(ApiError::bad("请填写有效的邮箱地址。"));
    }
    Ok(s)
}
pub fn password(value: &Value) -> Result<String> {
    let s = value.as_str().unwrap_or("");
    if !(10..=128).contains(&s.encode_utf16().count()) {
        return Err(ApiError::bad("密码需要 10 到 128 个字符。"));
    }
    Ok(s.to_owned())
}
pub fn only_fields(body: &Value, fields: &[&str]) -> Result<()> {
    if !body
        .as_object()
        .is_some_and(|v| v.keys().all(|k| fields.contains(&k.as_str())))
    {
        return Err(ApiError::bad("账户设置包含不支持的字段。"));
    }
    Ok(())
}
