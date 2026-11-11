use openbot_backend::{config::Config, db::State, operations_router, product_router};
use std::{net::SocketAddr, path::PathBuf};
mod deployment_lock;
mod shutdown_signal;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let signal = shutdown_signal::register()?;
    let (signal_tx, mut signal_rx) = tokio::sync::watch::channel(false);
    let signal_monitor = tokio::spawn(async move {
        signal.await;
        signal_tx.send_replace(true);
    });
    let mut args = std::env::args().skip(1);
    let mut directory = None;
    let mut bind = None;
    let mut provision = false;
    let mut origin = None;
    let mut config_path = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir"=>directory=args.next().map(PathBuf::from),
            "--bind"=>bind=Some(args.next().ok_or("--bind requires an address")?.parse::<SocketAddr>()?),
            "--public-origin"=>origin=args.next(),
            "--init-operator"=>provision=true,
            "--config"=>config_path=args.next().map(PathBuf::from),
            _=>return Err("Usage: openbot-backend --data-dir PATH [--bind 127.0.0.1:PORT] [--public-origin https://HOST] [--init-operator]".into()),
        }
    }
    let mut config = if let Some(path) = config_path {
        if directory.is_some() || bind.is_some() || origin.is_some() {
            return Err("Use either --config or explicit deployment options, not both.".into());
        }
        Config::from_private_file(&path).map_err(|e| e.message)?
    } else {
        Config::local(directory.ok_or("An explicit --data-dir or --config is required; production data is never selected implicitly.")?)
    };
    if let Some(bind) = bind {
        config.bind = bind;
    }
    if origin.is_some() {
        config.public_origin = origin;
    }
    let address = config.bind;
    config.validate().map_err(|e| e.message)?;
    let _writer = deployment_lock::DeploymentLock::acquire(&config.data_dir)?;
    // Claim the listener before initialization so an occupied address cannot trigger recovery writes.
    let listener = tokio::net::TcpListener::bind(address).await?;
    config.bind = listener.local_addr()?;
    let operations_listener = if let Some(operations) = &mut config.operations {
        let listener = tokio::net::TcpListener::bind(operations.bind).await?;
        operations.bind = listener.local_addr()?;
        Some(listener)
    } else {
        None
    };
    let state = State::open(config).await.map_err(|e| e.message)?;
    let cancelled = *signal_rx.borrow();
    if cancelled {
        state.close().await;
        signal_monitor.abort();
        return Ok(());
    }
    if provision {
        let path = tokio::select! {
            biased;
            _ = signal_rx.wait_for(|value| *value) => {
                state.close().await;
                signal_monitor.abort();
                return Ok(());
            }
            result = state.provision_operator() => result.map_err(|e| e.message)?,
        };
        eprintln!(
            "Operator setup code is stored privately at {}",
            path.display()
        );
    }
    let cancelled = *signal_rx.borrow();
    if cancelled {
        state.close().await;
        signal_monitor.abort();
        return Ok(());
    }
    eprintln!(
        "MosoCrew Rust backend listening on {}",
        listener.local_addr()?
    );
    let mut ready = serde_json::json!({"type":"openbot:ready","backend":"rust","address":listener.local_addr()?.to_string()});
    if let Some(operations) = &operations_listener {
        ready["operationsAddress"] = serde_json::json!(operations.local_addr()?.to_string());
        if let Some(origin) = state
            .config
            .operations
            .as_ref()
            .and_then(|o| o.web_origin.as_ref())
        {
            ready["operationsWebOrigin"] = serde_json::json!(origin);
        }
    }
    println!("{ready}");
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let mut servers = tokio::task::JoinSet::new();
    serve(
        &mut servers,
        listener,
        product_router(state.clone()),
        stop_rx.clone(),
    );
    if let Some(listener) = operations_listener {
        serve(
            &mut servers,
            listener,
            operations_router(state.clone()),
            stop_rx,
        );
    }
    state.scheduler.start(state.clone()).await;
    let first = tokio::select! {
        _ = signal_rx.wait_for(|value| *value) => None,
        result = servers.join_next() => result,
    };
    stop_tx.send_replace(true);
    state.close().await;
    let mut outcome = match first {
        Some(Ok(result)) => result,
        Some(Err(error)) => Err(std::io::Error::other(error)),
        None => Ok(()),
    };
    while let Some(result) = servers.join_next().await {
        match result {
            Ok(Err(error)) if outcome.is_ok() => outcome = Err(error),
            Err(error) if outcome.is_ok() => outcome = Err(std::io::Error::other(error)),
            _ => {}
        }
    }
    signal_monitor.abort();
    outcome?;
    Ok(())
}

fn serve(
    servers: &mut tokio::task::JoinSet<std::io::Result<()>>,
    listener: tokio::net::TcpListener,
    router: axum::Router,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    servers.spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = stop.wait_for(|value| *value).await;
        })
        .await
    });
}
