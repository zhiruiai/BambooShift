use crate::{
    db::State,
    error::{ApiError, Result},
};
use axum::{
    body::Body,
    extract::{Request, State as Extract},
    http::{Method, header},
    response::{IntoResponse, Response},
};
use std::{io::Read, path::Path};

fn missing() -> ApiError {
    ApiError::new(404, "页面或资源不存在。")
}
fn mime(path: &str) -> Option<&'static str> {
    Some(match path.rsplit('.').next()? {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "webmanifest" => "application/manifest+json",
        _ => return None,
    })
}
fn read(root: &Path, name: &str) -> Result<Vec<u8>> {
    let parts = name.split('/').collect::<Vec<_>>();
    let (file_name, directories) = parts.split_last().ok_or_else(missing)?;
    let mut directory = crate::filesystem::open_root(root)?;
    for component in directories {
        directory = crate::filesystem::open_dir(&directory, component)?;
    }
    let file = crate::filesystem::open_file(&directory, file_name)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 10 * 1024 * 1024 {
        return Err(missing());
    }
    let mut bytes = Vec::new();
    file.take(10 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(missing());
    }
    Ok(bytes)
}

pub async fn fallback(Extract(state): Extract<State>, request: Request) -> Response {
    serve(state, request, "dist", false).await
}
pub async fn product_fallback(Extract(state): Extract<State>, request: Request) -> Response {
    let path = request.uri().path();
    if path == "/admin" || path.starts_with("/admin/") {
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            return missing().into_response();
        }
        let destination = state
            .config
            .operations
            .as_ref()
            .and_then(|ops| ops.public_origin.as_ref().or(ops.web_origin.as_ref()));
        let Some(origin) = destination else {
            return missing().into_response();
        };
        if path.contains(['\\', '%', '\0']) {
            return missing().into_response();
        }
        let target = format!(
            "{origin}{}",
            request
                .uri()
                .path_and_query()
                .map(|v| v.as_str())
                .unwrap_or(path)
        );
        return axum::response::Redirect::temporary(&target).into_response();
    }
    if path == "/operations-dist" || path.starts_with("/operations-dist/") {
        return missing().into_response();
    }
    serve(state, request, "dist", false).await
}
pub async fn operations_fallback(Extract(state): Extract<State>, request: Request) -> Response {
    serve(state, request, "operations-dist", true).await
}
async fn serve(state: State, request: Request, directory: &str, operations: bool) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().trim_start_matches('/');
    if !matches!(method, Method::GET | Method::HEAD) || path == "api" || path.starts_with("api/") {
        return missing().into_response();
    }
    // Serve only the built public UI. Source, configuration, data and maps never enter this tree.
    if path.len() > 4096
        || path
            .split('/')
            .any(|s| s.starts_with('.') || s.contains(['\\', '%', '\0']))
    {
        return missing().into_response();
    }
    if operations
        && !path.is_empty()
        && path != "admin"
        && !path.starts_with("admin/")
        && !path.rsplit('/').next().unwrap_or("").contains('.')
    {
        return missing().into_response();
    }
    let name = if path.is_empty() || !path.rsplit('/').next().unwrap_or("").contains('.') {
        "index.html"
    } else {
        path
    };
    let Some(content_type) = mime(name) else {
        return missing().into_response();
    };
    let name = name.to_owned();
    let root = state.config.runtime_dir.join(directory);
    match tokio::task::spawn_blocking(move || read(&root, &name)).await {
        Ok(Ok(bytes)) => {
            let length = bytes.len();
            let mut response = Response::new(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(bytes)
            });
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, content_type.parse().unwrap());
            response
                .headers_mut()
                .insert(header::CONTENT_LENGTH, length.into());
            response
        }
        _ => missing().into_response(),
    }
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;
