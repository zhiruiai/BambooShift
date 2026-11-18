use super::*;

#[tokio::test]
async fn saving_a_connection_preserves_an_unreadable_existing_record() {
    let directory = tempfile::tempdir().unwrap();
    let store = WorkspaceStore::open(directory.path()).await.unwrap();
    let mut connection: Connection = serde_json::from_value(json!({
        "id":"example", "name":"Example", "url":"https://example.com/",
        "revision":"initial", "authType":"none", "status":"disconnected", "tools":[]
    }))
    .unwrap();
    save(&store, &connection).await.unwrap();
    let before = store.sync();
    let wrong_id = serde_json::to_string(&connection).unwrap();
    for (id, raw) in [
        ("partial", "{}"),
        ("malformed", "incomplete"),
        ("mismatch", wrong_id.as_str()),
    ] {
        connection.id = id.into();
        sqlx::query("INSERT INTO app_connections(id,data) VALUES(?,?)")
            .bind(id)
            .bind(raw)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            save(&store, &connection).await.unwrap_err().status.as_u16(),
            409
        );
        let saved: String = sqlx::query_scalar("SELECT data FROM app_connections WHERE id=?")
            .bind(id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(saved, raw);
        assert_eq!(store.sync(), before);
    }
    store.close().await;
}
