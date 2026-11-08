use crate::{
    db::State,
    error::{ApiError, Result},
};
use serde_json::Value;
pub fn endpoint(state: &State, value: &Value) -> Result<String> {
    let raw = value
        .as_str()
        .filter(|s| s.len() <= 2048)
        .ok_or_else(|| ApiError::bad("请输入有效的 HTTPS 应用服务地址。"))?;
    let url = url::Url::parse(raw.trim())
        .map_err(|_| ApiError::bad("请输入有效的 HTTPS 应用服务地址。"))?;
    let fixture = state
        .apps
        .fixture_origins
        .contains(&url.origin().ascii_serialization());
    if (!fixture && (url.scheme() != "https" || url.port().is_some_and(|p| p != 443)))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::bad(
            "应用地址须使用 HTTPS 默认端口，不能包含登录信息、查询参数或片段。",
        ));
    }
    if let Some(own) = &state.config.public_origin {
        if url::Url::parse(own)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            == url.host_str().map(str::to_owned)
        {
            return Err(ApiError::bad("不能把平台自身连接为应用服务。"));
        }
    }
    let host = url.host_str().unwrap_or("");
    if !fixture && (host == "localhost" || host.ends_with(".localhost") || !public_host(&url)) {
        return Err(ApiError::bad("请使用公网 HTTPS 应用域名。"));
    }
    Ok(url.to_string())
}
fn public_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || b == 0))
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        Some(url::Host::Ipv6(ip)) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] == 0xdb8 || s[1] == 0))
                && s[0] != 0x2002
        }
        Some(url::Host::Domain(_)) => true,
        None => false,
    }
}
