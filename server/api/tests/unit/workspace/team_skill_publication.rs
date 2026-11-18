use super::commit;
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use std::{future::Future, task::Poll, time::Duration};

async fn pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn accepted_commit_survives_request_future_cancellation() {
    let team = pool().await;
    let source = pool().await;
    let platform = pool().await;
    sqlx::query("CREATE TABLE receipt (id TEXT PRIMARY KEY)")
        .execute(&team)
        .await
        .unwrap();
    let mut pending = team.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("INSERT INTO receipt VALUES ('synthetic')")
        .execute(&mut *pending)
        .await
        .unwrap();
    let personal = source.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let identity = platform.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let mut accepted = Box::pin(commit(pending, Some(personal), identity, None));
    std::future::poll_fn(|context| {
        assert!(accepted.as_mut().poll(context).is_pending());
        assert!(source.try_acquire().is_none());
        assert!(platform.try_acquire().is_none());
        Poll::Ready(())
    })
    .await;
    drop(accepted);

    tokio::time::timeout(Duration::from_secs(3), async {
        let receipt: String = sqlx::query_scalar("SELECT id FROM receipt")
            .fetch_one(&team)
            .await
            .unwrap();
        assert_eq!(receipt, "synthetic");
        source.begin().await.unwrap().rollback().await.unwrap();
        platform.begin().await.unwrap().rollback().await.unwrap();
    })
    .await
    .unwrap();
}
