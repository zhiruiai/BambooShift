mod avatar_codec;
use std::io::{Read, Write};

fn main() {
    resource_limits();
    let result = std::panic::catch_unwind(|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(36 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| avatar_codec::Failure::Invalid)?;
        if bytes.len() > 36 * 1024 * 1024 {
            return Err(avatar_codec::Failure::TooLarge);
        }
        let request = serde_json::from_slice(&bytes).map_err(|_| avatar_codec::Failure::Invalid)?;
        avatar_codec::process(request)
    })
    .unwrap_or(Err(avatar_codec::Failure::Invalid));
    let envelope = match result {
        Ok(output) => serde_json::json!({"ok":true,"result":output}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    };
    if let Ok(bytes) = serde_json::to_vec(&envelope) {
        let _ = std::io::stdout().write_all(&bytes);
    }
}
fn resource_limits() {
    #[cfg(unix)]
    unsafe {
        for (resource, value) in [
            (libc::RLIMIT_CPU, 10),
            (libc::RLIMIT_CORE, 0),
            (libc::RLIMIT_NOFILE, 32),
        ] {
            libc::setrlimit(
                resource,
                &libc::rlimit {
                    rlim_cur: value,
                    rlim_max: value,
                },
            );
        }
        #[cfg(target_os = "linux")]
        libc::setrlimit(
            libc::RLIMIT_AS,
            &libc::rlimit {
                rlim_cur: 1024 * 1024 * 1024,
                rlim_max: 1024 * 1024 * 1024,
            },
        );
    }
}
