use super::{Group, get, read_zip};
use axum::http::header;
use serde_json::Value;

pub(super) async fn verify(group: &Group, id: &str, original_zip: &[u8]) {
    let root = group.f.path(&format!("/website-projects/{id}"));
    let directory = group.store.directory.to_string_lossy();
    for path in ["index.html", "assets/logo.png"] {
        let original: Vec<u8> = sqlx::query_scalar(
            "SELECT bytes FROM website_project_files WHERE project_id=? AND path=?",
        )
        .bind(id)
        .bind(path)
        .fetch_one(&group.store.pool)
        .await
        .unwrap();
        let mut corrupted = original.clone();
        corrupted[0] ^= 1;
        assert_eq!(corrupted.len(), original.len());
        replace(group, id, path, &corrupted).await;

        let mut expected_error = None;
        for endpoint in [format!("{root}/files/{path}"), format!("{root}/download")] {
            let (status, headers, body) = get(&group.f, &endpoint, Some(&group.f.owner)).await;
            assert_eq!(
                status, 409,
                "Same-length damaged {path} must not be exported"
            );
            assert_eq!(headers[header::CONTENT_TYPE], "application/json");
            assert!(!headers.contains_key(header::CONTENT_DISPOSITION));
            let error: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(error["code"], "WEBSITE_PROJECT_CHANGED");
            assert_eq!(error.as_object().unwrap().len(), 2);
            assert!(error["error"].as_str().is_some_and(|text| !text.is_empty()));
            let text = String::from_utf8(body).unwrap();
            assert!(
                !text.contains(directory.as_ref()),
                "Do not expose storage paths"
            );
            assert!(!text.contains(path), "Do not expose internal asset paths");
            if let Some(expected) = expected_error.as_ref() {
                assert_eq!(&error, expected, "ZIP and single-file checks must agree");
            } else {
                expected_error = Some(error);
            }
        }

        replace(group, id, path, &original).await;
        let (status, headers, bytes) =
            get(&group.f, &format!("{root}/download"), Some(&group.f.owner)).await;
        assert_eq!(status, 200);
        assert_eq!(headers[header::CONTENT_TYPE], "application/zip");
        assert_eq!(read_zip(&bytes), read_zip(original_zip));
    }
}

async fn replace(group: &Group, id: &str, path: &str, bytes: &[u8]) {
    let changed =
        sqlx::query("UPDATE website_project_files SET bytes=? WHERE project_id=? AND path=?")
            .bind(bytes)
            .bind(id)
            .bind(path)
            .execute(&group.store.pool)
            .await
            .unwrap();
    assert_eq!(changed.rows_affected(), 1);
}
