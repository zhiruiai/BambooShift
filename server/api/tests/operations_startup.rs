use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::{TcpListener, TcpStream},
    process::Command,
};

fn configuration(
    root: &Path,
    product: std::net::SocketAddr,
    operations: std::net::SocketAddr,
) -> std::path::PathBuf {
    let runtime = root.join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let config = json!({"dataDir":root.join("data"),"bind":product.to_string(),"runtimeDir":runtime,"operations":{"bind":operations.to_string()}});
    let path = root.join("server.private.json");
    std::fs::write(&path, config.to_string()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path
}

#[tokio::test]
async fn occupied_product_or_operations_listener_fails_before_database_initialization() {
    for occupied_operations in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = occupied.local_addr().unwrap();
        let ephemeral = "127.0.0.1:0".parse().unwrap();
        let config = configuration(
            directory.path(),
            if occupied_operations {
                ephemeral
            } else {
                address
            },
            if occupied_operations {
                address
            } else {
                ephemeral
            },
        );
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(env!("CARGO_BIN_EXE_openbot-backend"))
                .arg("--config")
                .arg(config)
                .arg("--init-operator")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("openbot:ready"));
        assert!(
            !directory
                .path()
                .join("data/platform/identity.sqlite")
                .exists()
        );
        assert!(
            !directory
                .path()
                .join("data/platform/operator-setup-code")
                .exists()
        );
        assert!(!directory.path().join("data/spaces").exists());
    }
}

#[tokio::test]
async fn one_process_serves_two_listeners_and_sigterm_closes_both_before_releasing_database() {
    let directory = tempfile::tempdir().unwrap();
    let ephemeral = "127.0.0.1:0".parse().unwrap();
    let config = configuration(directory.path(), ephemeral, ephemeral);
    let mut child = Command::new(env!("CARGO_BIN_EXE_openbot-backend"))
        .arg("--config")
        .arg(&config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let ready: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(10), output.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ready["type"], "openbot:ready");
    assert!(ready.get("operationsWebOrigin").is_none());
    let product = ready["address"].as_str().unwrap();
    let operations = ready["operationsAddress"].as_str().unwrap();
    assert_ne!(product, operations);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    for address in [product, operations] {
        assert_eq!(
            client
                .get(format!("http://{address}/api/health"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        client
            .get(format!("http://{product}/api/platform/session"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client
            .get(format!("http://{operations}/api/account/session"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let registration = client.post(format!("http://{product}/api/account/register")).json(&json!({"email":"shutdown@example.test","name":"Synthetic account","password":"synthetic-password-42","kind":"personal"})).send().await.unwrap();
    assert_eq!(registration.status(), 201);
    assert_eq!(
        unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGTERM) },
        0
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    for address in [product, operations] {
        assert!(TcpStream::connect(address).await.is_err());
    }
    let db = sqlx::SqlitePool::connect(&format!(
        "sqlite:{}",
        directory
            .path()
            .join("data/platform/identity.sqlite")
            .display()
    ))
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("CREATE TABLE shutdown_verified(value TEXT)")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    db.close().await;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.path().join("data/platform/backend.lock"))
        .unwrap();
    use std::os::fd::AsRawFd;
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
}
