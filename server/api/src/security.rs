use crate::{
    db::{State, now},
    error::{ApiError, Result},
    password::digest,
};
use axum::{
    body::HttpBody,
    extract::{ConnectInfo, Request, State as Extract},
    http::{HeaderMap, Method, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

pub async fn guard(Extract(state): Extract<State>, request: Request, next: Next) -> Response {
    scoped_guard(state, request, next, false).await
}
pub async fn operations_guard(
    Extract(state): Extract<State>,
    request: Request,
    next: Next,
) -> Response {
    scoped_guard(state, request, next, true).await
}
async fn scoped_guard(state: State, request: Request, next: Next, operations: bool) -> Response {
    let english = crate::error_locale::english(request.headers());
    let path = request.uri().path();
    let link_navigation = share_link_path(path, operations);
    let shared_website = !operations
        && (path.starts_with("/pages/") || path.starts_with("/api/public/website-projects/"));
    let team_skill_link = !operations && team_skill_link_path(path);
    let routine_webhook = !operations && crate::scheduling::is_webhook_ingress(path);
    let result = verify(&state, &request, operations);
    let mut response = match result {
        Ok(()) => next.run(request).await,
        Err(e) => e.into_response(),
    };
    if english && response.status().is_client_error()
        || english && response.status().is_server_error()
    {
        response = crate::error_locale::translate(response).await;
    }
    let status = response.status();
    let h = response.headers_mut();
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert("referrer-policy", "no-referrer".parse().unwrap());
    let cache = if h
        .get(header::CACHE_CONTROL)
        .is_some_and(|value| value == "private, no-store")
    {
        "private, no-store"
    } else {
        "no-store"
    };
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(cache),
    );
    h.insert(
        header::CONTENT_LANGUAGE,
        if english { "en" } else { "zh-CN" }.parse().unwrap(),
    );
    h.insert(header::VARY, "Accept-Language".parse().unwrap());
    if routine_webhook {
        if status == axum::http::StatusCode::UNAUTHORIZED {
            h.insert(
                header::WWW_AUTHENTICATE,
                header::HeaderValue::from_static("Bearer"),
            );
        } else if status == axum::http::StatusCode::TOO_MANY_REQUESTS {
            h.insert(header::RETRY_AFTER, header::HeaderValue::from_static("60"));
        }
    }
    if shared_website || team_skill_link {
        h.insert(
            "x-robots-tag",
            "noindex, nofollow, noarchive".parse().unwrap(),
        );
    }
    if link_navigation {
        h.insert("x-frame-options", "DENY".parse().unwrap());
        h.insert(
            "content-security-policy",
            "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
                .parse()
                .unwrap(),
        );
    }
    if (operations || state.config.public_origin.is_some()) && !link_navigation {
        h.insert("x-frame-options", "DENY".parse().unwrap());
        h.append(
            "content-security-policy",
            "frame-ancestors 'none'".parse().unwrap(),
        );
    }
    response
}
fn share_link_path(path: &str, operations: bool) -> bool {
    path.strip_prefix("/templates/")
        .is_some_and(crate::password::valid_token)
        || (!operations
            && (path
                .strip_prefix("/pages/")
                .is_some_and(crate::password::valid_token)
                || team_skill_link_path(path)))
}
fn team_skill_link_path(path: &str) -> bool {
    path.strip_prefix("/team-skills/").is_some_and(|path| {
        let mut ids = path.split('/');
        let canonical = |id: &str| {
            uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == id)
        };
        (0..3).all(|_| ids.next().is_some_and(canonical)) && ids.next().is_none()
    })
}
fn entry_navigation(request: &Request, operations: bool, redirect_admin: bool) -> bool {
    let path = request.uri().path();
    let admin = path == "/admin" || path.starts_with("/admin/");
    let allowed = if operations {
        path == "/" || admin
    } else {
        (redirect_admin && admin)
            || matches!(path, "/login" | "/register")
            || team_skill_link_path(path)
            || path.strip_prefix("/invite/").is_some_and(|token| {
                token.len() == 43
                    && token
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            || path.strip_prefix("/shared-bots/").is_some_and(|id| {
                uuid::Uuid::parse_str(id).is_ok_and(|value| value.hyphenated().to_string() == id)
            })
    };
    let headers = request.headers();
    allowed
        && *request.method() == Method::GET
        && headers
            .get("sec-fetch-mode")
            .is_some_and(|h| h == "navigate")
        && headers
            .get("sec-fetch-dest")
            .is_some_and(|h| h == "document")
        && headers
            .get(header::ACCEPT)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|part| {
                    part.split(';')
                        .next()
                        .is_some_and(|mime| mime.trim() == "text/html")
                })
            })
        && headers
            .get_all(header::CONTENT_LENGTH)
            .iter()
            .all(|h| h == "0")
        && !headers.contains_key(header::TRANSFER_ENCODING)
        && request.body().is_end_stream()
}
fn verify(state: &State, request: &Request, operations: bool) -> Result<()> {
    if state.is_closing() {
        return Err(ApiError::new(503, "服务正在停止，请稍后重试。"));
    }
    let deny = || ApiError::new(403, "此请求来源不受信任。");
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .ok_or_else(deny)?;
    if !peer.0.ip().is_loopback() {
        return Err(deny());
    }
    let headers = request.headers();
    let share_link = share_link_path(request.uri().path(), operations);
    let link_navigation = share_link && *request.method() == Method::GET;
    if share_link
        && (!link_navigation
            || request.uri().query().is_some()
            || headers
                .get(header::CONTENT_LENGTH)
                .is_some_and(|h| h != "0")
            || headers.contains_key(header::TRANSFER_ENCODING))
    {
        return Err(ApiError::bad("页面请求无效。"));
    }
    let oauth_navigation = *request.method() == Method::GET
        && matches!(
            request.uri().path(),
            "/api/app-oauth/callback" | "/api/app-oauth/result"
        )
        || (link_navigation && !team_skill_link_path(request.uri().path()));
    if !oauth_navigation
        && !entry_navigation(request, operations, state.config.operations.is_some())
        && headers
            .get("sec-fetch-site")
            .is_some_and(|h| h == "cross-site")
    {
        return Err(deny());
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(deny)?;
    let origin = headers
        .get(header::ORIGIN)
        .map(|h| h.to_str().map_err(|_| deny()))
        .transpose()?;
    if operations {
        return verify_operations_origin(state, request, host, origin);
    }
    let routine_webhook = *request.method() == Method::POST
        && crate::scheduling::is_webhook_ingress(request.uri().path())
        && request.uri().query().is_none()
        && !headers.contains_key(header::COOKIE);
    if let Some(public) = &state.config.public_origin {
        let configured = url::Url::parse(public).map_err(|_| deny())?;
        let current = url::Url::parse(&format!("https://{host}")).map_err(|_| deny())?;
        if current.origin() != configured.origin()
            || current.path() != "/"
            || current.query().is_some()
            || current.fragment().is_some()
            || !current.username().is_empty()
            || current.password().is_some()
            || (!oauth_navigation && origin.is_some_and(|o| o != public))
        {
            return Err(deny());
        }
        if !matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        ) && origin.is_none()
            && !routine_webhook
        {
            return Err(deny());
        }
    } else {
        let url = url::Url::parse(&format!("http://{host}")).map_err(|_| deny())?;
        if !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            || url.path() != "/"
            || url.query().is_some()
            || !url.username().is_empty()
        {
            return Err(deny());
        }
        if let Some(origin) = origin.filter(|_| !oauth_navigation) {
            if origin != format!("http://{host}")
                && origin != "http://localhost:5173"
                && origin != "http://127.0.0.1:5173"
                && state.config.web_origin.as_deref() != Some(origin)
            {
                return Err(deny());
            }
        }
    }
    Ok(())
}
pub(crate) async fn rate_limit(state: &State, address: SocketAddr, purpose: &str) -> Result<()> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let at = now();
    sqlx::query("DELETE FROM account_attempts WHERE started_at<?")
        .bind(at - 900_000)
        .execute(&mut *tx)
        .await?;
    let mut blocked = false;
    for (bucket, maximum, window) in [
        (
            format!("{purpose}:ip:{}", digest(&address.ip().to_string())),
            12,
            900_000,
        ),
        (format!("{purpose}:global"), 100, 60_000),
    ] {
        let old = sqlx::query_as::<_, (i64, i64)>(
            "SELECT started_at,attempts FROM account_attempts WHERE bucket=?",
        )
        .bind(&bucket)
        .fetch_optional(&mut *tx)
        .await?;
        let (started, count) = old
            .filter(|(s, _)| *s + window > at)
            .map(|(s, n)| (s, n + 1))
            .unwrap_or((at, 1));
        sqlx::query("INSERT INTO account_attempts VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET started_at=excluded.started_at,attempts=excluded.attempts").bind(bucket).bind(started).bind(count).execute(&mut *tx).await?;
        blocked |= count > maximum;
    }
    tx.commit().await?;
    if blocked {
        Err(ApiError::new(429, "尝试过于频繁，请稍后重试。"))
    } else {
        Ok(())
    }
}
pub(crate) fn with_cookie(headers: &mut HeaderMap, cookie: String) {
    headers.append(
        header::SET_COOKIE,
        cookie.parse().expect("generated cookie"),
    );
}

fn verify_operations_origin(
    state: &State,
    request: &Request,
    host: &str,
    origin: Option<&str>,
) -> Result<()> {
    let deny = || ApiError::new(403, "此请求来源不受信任。");
    let config = state.config.operations.as_ref().ok_or_else(deny)?;
    let scheme = if config.public_origin.is_some() {
        "https"
    } else {
        "http"
    };
    let supplied = url::Url::parse(&format!("{scheme}://{host}")).map_err(|_| deny())?;
    if supplied.path() != "/"
        || supplied.query().is_some()
        || supplied.fragment().is_some()
        || !supplied.username().is_empty()
        || supplied.password().is_some()
    {
        return Err(deny());
    }
    let local = format!("http://{}", config.bind);
    let entry = config.public_origin.as_deref().unwrap_or(&local);
    let current = supplied.origin().ascii_serialization();
    let valid_host = current == entry
        || (config.public_origin.is_none()
            && config.web_origin.as_deref() == Some(current.as_str()));
    if !valid_host
        || origin.is_some_and(|value| value != entry && config.web_origin.as_deref() != Some(value))
    {
        return Err(deny());
    }
    if config.public_origin.is_some()
        && !matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        )
        && origin.is_none()
    {
        return Err(deny());
    }
    Ok(())
}
