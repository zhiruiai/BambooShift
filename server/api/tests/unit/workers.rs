use super::*;
fn config() -> (tempfile::TempDir, Config) {
    let d = tempfile::tempdir().unwrap();
    let mut c = Config::local(d.path().join("data"));
    c.runtime_dir = d.path().to_owned();
    c.node_binary = std::env::current_exe().unwrap();
    (d, c)
}
#[test]
fn bundle_wins_without_a_source_tree_or_tsx_and_development_uses_only_the_explicit_loader() {
    let (_d, c) = config();
    let base = c.runtime_dir.join("packages/pi-worker");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::write(base.join("index.mjs"), "").unwrap();
    let built = command(&c, Worker::Agent, &["--max-old-space-size=192"]).unwrap();
    let args = built
        .as_std()
        .get_args()
        .map(|v| v.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        args,
        vec![
            "--max-old-space-size=192".to_owned(),
            base.join("index.mjs").to_string_lossy().to_string()
        ]
    );
    let environment: std::collections::BTreeMap<_, _> = built.as_std().get_envs().collect();
    assert_eq!(environment.len(), if cfg!(windows) { 4 } else { 1 });
    assert!(environment.contains_key(std::ffi::OsStr::new("LANG")));
    #[cfg(windows)]
    for (key, value) in [
        ("SystemRoot", std::env::var_os("SystemRoot").unwrap()),
        ("TEMP", std::env::temp_dir().into_os_string()),
        ("TMP", std::env::temp_dir().into_os_string()),
    ] {
        assert_eq!(
            environment
                .get(std::ffi::OsStr::new(key))
                .copied()
                .flatten(),
            Some(value.as_os_str())
        );
    }
    std::fs::remove_file(base.join("index.mjs")).unwrap();
    let source = c.runtime_dir.join("server/workers/pi-worker/index.ts");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, "").unwrap();
    assert!(command(&c, Worker::Agent, &[]).is_err());
    let loader = c.runtime_dir.join("node_modules/tsx/dist/loader.mjs");
    std::fs::create_dir_all(loader.parent().unwrap()).unwrap();
    std::fs::write(&loader, "").unwrap();
    let dev = command(&c, Worker::Agent, &[]).unwrap();
    let args = dev.as_std().get_args().collect::<Vec<_>>();
    assert_eq!(args[0], "--import");
    let preload = url::Url::parse(args[1].to_str().unwrap()).unwrap();
    assert_eq!(preload.scheme(), "file");
    assert_eq!(preload.to_file_path().unwrap(), loader);
    assert_eq!(args[2], source);
}
#[test]
fn malformed_bundle_never_silently_falls_back_and_document_source_has_no_loader() {
    let (_d, c) = config();
    let base = c.runtime_dir.join("packages/document-worker");
    std::fs::create_dir_all(&base).unwrap();
    let source = c
        .runtime_dir
        .join("server/workers/document-worker/index.ts");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, "").unwrap();
    let dev = command(&c, Worker::Document, &[]).unwrap();
    assert_eq!(
        dev.as_std().get_args().next().unwrap(),
        "--experimental-strip-types"
    );
    std::fs::create_dir(base.join("index.mjs")).unwrap();
    assert!(command(&c, Worker::Document, &[]).is_err());
    #[cfg(unix)]
    {
        std::fs::remove_dir(base.join("index.mjs")).unwrap();
        std::os::unix::fs::symlink("missing.mjs", base.join("index.mjs")).unwrap();
        assert!(command(&c, Worker::Document, &[]).is_err());
    }
}
