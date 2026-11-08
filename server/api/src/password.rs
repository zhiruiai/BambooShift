use crate::{
    db::State,
    error::{ApiError, Result},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub(crate) fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
pub(crate) fn token() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
pub(crate) fn valid_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
async fn derive(state: &State, value: String, salt: String) -> Result<[u8; 32]> {
    let permit = state
        .hash_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(429, "登录服务繁忙，请稍后重试。"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut out = [0; 32];
        let params = scrypt::Params::new(15, 8, 3, 32)
            .map_err(|_| ApiError::new(500, "密码服务不可用。"))?;
        scrypt::scrypt(value.as_bytes(), salt.as_bytes(), &params, &mut out)
            .map_err(|_| ApiError::new(500, "密码服务不可用。"))?;
        Ok(out)
    })
    .await
    .map_err(|_| ApiError::new(500, "密码服务不可用。"))?
}
pub(crate) async fn hash(state: &State, value: String) -> Result<String> {
    let mut salt = [0; 24];
    OsRng.fill_bytes(&mut salt);
    let salt = hex::encode(salt);
    let key = derive(state, value, salt.clone()).await?;
    Ok(format!("scrypt-v1:{salt}:{}", hex::encode(key)))
}
pub(crate) async fn check(state: &State, value: String, saved: &str) -> Result<bool> {
    let parts: Vec<_> = saved.split(':').collect();
    let valid = parts.len() == 3
        && parts[0] == "scrypt-v1"
        && parts[1].len() == 48
        && parts[2].len() == 64
        && parts[1..].iter().all(|p| {
            p.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
    let key = derive(
        state,
        value,
        if valid {
            parts[1].to_owned()
        } else {
            "0".repeat(48)
        },
    )
    .await?;
    let expected = if valid {
        hex::decode(parts[2]).unwrap_or_default()
    } else {
        vec![0; 32]
    };
    Ok(valid && bool::from(key.as_slice().ct_eq(&expected)))
}
