#![allow(dead_code)]
use crate::workspace_support::Fixture;
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use serde_json::Value;
use std::net::SocketAddr;
use tower::ServiceExt;

pub async fn raw(
    f: &Fixture,
    method: &str,
    path: &str,
    mime: &str,
    body: Body,
    member: bool,
    expected: Option<&str>,
) -> (u16, HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3002")
        .header("origin", "http://127.0.0.1:3002")
        .header(
            "cookie",
            format!(
                "openbot_account={}",
                if member {
                    &f.member_token
                } else {
                    &f.owner_token
                }
            ),
        )
        .header("content-type", mime);
    if let Some(id) = expected {
        request = request.header("x-openbot-expected-user", id);
    }
    let mut request = request.body(body).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41322".parse::<SocketAddr>().unwrap(),
    ));
    let response = openbot_backend::router(f.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 26 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (status, headers, bytes)
}
pub fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}
pub fn png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(width, height, |x, _| {
        if x < width / 2 {
            image::Rgba([240, 20, 20, 255])
        } else {
            image::Rgba([20, 20, 240, 80])
        }
    });
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
