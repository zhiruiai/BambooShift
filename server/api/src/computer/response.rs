use super::transport::Reply;
use crate::error::{ApiError, Result};
use futures_util::StreamExt;

pub(crate) async fn read(response: reqwest::Response, limit: usize) -> Result<Reply> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(ApiError::new(413, "电脑返回内容过大。"));
    }
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let mut chunks = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| ApiError::new(502, "电脑返回内容未完整接收。"))?;
        if bytes.len() + chunk.len() > limit {
            return Err(ApiError::new(413, "电脑返回内容过大。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Reply {
        status,
        headers,
        bytes,
    })
}
