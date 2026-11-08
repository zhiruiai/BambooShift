use std::{future::Future, io};

/// Register before opening storage so termination is latched throughout initialization.
#[cfg(unix)]
pub fn register() -> io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        tokio::select! { _=terminate.recv()=>{}, _=interrupt.recv()=>{} }
    })
}
#[cfg(not(unix))]
pub fn register() -> io::Result<impl Future<Output = ()>> {
    Ok(async {
        let _ = tokio::signal::ctrl_c().await;
    })
}
