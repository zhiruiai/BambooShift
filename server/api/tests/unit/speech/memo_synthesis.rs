use super::*;

const CONFIG: &[u8] =
    br#"{"version":1,"enabled":true,"voices":{"zh-CN":"Tingting","en-US":"Samantha"}}"#;
const ESPEAK_CONFIG: &[u8] = br#"{"version":1,"enabled":true,"engine":"espeak-ng","voices":{"zh-CN":"cmn","en-US":"en-us"}}"#;

fn wav(sample: i16, frames: usize) -> Vec<u8> {
    let length = (frames * 2) as u32;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend((48 + length).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(16000u32.to_le_bytes());
    bytes.extend(32000u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"JUNK");
    bytes.extend(4u32.to_le_bytes());
    bytes.extend(b"meta");
    bytes.extend(b"data");
    bytes.extend(length.to_le_bytes());
    for _ in 0..frames {
        bytes.extend(sample.to_le_bytes());
    }
    bytes
}

#[test]
fn text_and_catalog_require_exact_supported_values() {
    assert!(validate_text("Hello.\n你好。").is_ok());
    assert!(validate_text(&"😀".repeat(250)).is_ok());
    for value in ["  ", "\0test", "Hello [[slnc 200]]", "Hello ]]"] {
        assert!(validate_text(value).is_err());
    }
    assert!(validate_text(&"😀".repeat(251)).is_err());
    assert!(Locale::parse("en-GB").is_err());
    let installed = concat!(
        "Tingting               zh_CN    # Chinese\n",
        "Samantha               en_US    # English\n",
        "English Demo (US)      en_US    # Another voice",
    );
    assert!(has_voice(installed, "Tingting", Locale::Chinese));
    assert!(has_voice(installed, "Samantha", Locale::English));
    assert!(has_voice(installed, "English Demo (US)", Locale::English));
    assert!(!has_voice(installed, "Samantha", Locale::Chinese));
    assert!(!has_voice(installed, "English Demo", Locale::English));
}

#[test]
fn keeps_only_bounded_non_silent_canonical_pcm() {
    let normalized = canonical_wave(&wav(1000, 1600)).unwrap();
    assert_eq!(normalized.duration_ms, 100);
    assert_eq!(normalized.bytes.len(), 44 + 3200);
    assert_eq!(&normalized.bytes[36..40], b"data");
    assert!(canonical_wave(b"not-a-wave").is_err());
    assert!(canonical_wave(&wav(0, 1600)).is_err());
    assert!(canonical_wave(&wav(1000, 16000 * 60 + 1)).is_err());
    assert!(canonical_wave(&vec![0; super::super::wav::MAX_BYTES + 1]).is_err());
}

#[test]
fn espeak_catalog_and_pcm_use_only_the_verified_native_shape() {
    let catalog = concat!(
        "Pty Language Age/Gender VoiceName File\n",
        "5 cmn --/M Mandarin_(Chinese) sit/cmn (zh 5)\n",
        "2 en-us --/M English_(America) gmw/en-US",
    );
    assert!(espeak::has_voice(catalog, "cmn"));
    assert!(espeak::has_voice(catalog, "en-us"));
    assert!(!espeak::has_voice(catalog, "zh"));

    let mut raw = wav(1234, 2205);
    raw.drain(36..48);
    let length = raw.len() as u32;
    raw[4..8].copy_from_slice(&(length - 8).to_le_bytes());
    raw[24..28].copy_from_slice(&22_050u32.to_le_bytes());
    raw[28..32].copy_from_slice(&44_100u32.to_le_bytes());
    let normalized = canonical_wave(&espeak::normalize(&raw).unwrap()).unwrap();
    assert_eq!(normalized.duration_ms, 100);
    assert_eq!(normalized.bytes.len(), 44 + 3200);
    assert_eq!(&normalized.bytes[44..46], &1234i16.to_le_bytes());
    raw[22] = 2;
    assert!(espeak::normalize(&raw).is_err());
}

#[cfg(unix)]
fn configured() -> tempfile::TempDir {
    with_config(CONFIG)
}

#[cfg(unix)]
fn with_config(config: &[u8]) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let speech = directory.path().join("speech");
    create_private_directory(&speech).unwrap();
    private_write(&speech.join("memo-synthesis.json"), config).unwrap();
    directory
}

#[cfg(unix)]
#[test]
fn private_configuration_and_scratch_refuse_symlinks() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let directory = configured();
    let config = directory.path().join("speech/memo-synthesis.json");
    let configured = read_config(directory.path()).unwrap();
    assert!(matches!(configured.engine, Engine::MacosSay));
    assert_eq!(Locale::Chinese.voice(&configured.voices), "Tingting");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_config(directory.path()).is_err());
    fs::remove_file(&config).unwrap();
    let elsewhere = directory.path().join("config.json");
    private_write(&elsewhere, CONFIG).unwrap();
    symlink(&elsewhere, config).unwrap();
    assert!(read_config(directory.path()).is_err());
    symlink(
        directory.path(),
        directory.path().join("speech/memo-temporary"),
    )
    .unwrap();
    assert!(Scratch::create(directory.path()).is_err());
}

#[cfg(unix)]
#[test]
fn espeak_is_an_explicit_linux_engine_and_disallows_arbitrary_voice_paths() {
    let directory = with_config(ESPEAK_CONFIG);
    let configured = read_config(directory.path()).unwrap();
    assert!(matches!(configured.engine, Engine::EspeakNg));
    assert_eq!(Locale::Chinese.voice(&configured.voices), "cmn");
    if !cfg!(target_os = "linux") {
        assert!(!available(directory.path()));
    }
    let invalid = with_config(
        br#"{"version":1,"enabled":true,"engine":"espeak-ng","voices":{"zh-CN":"zh","en-US":"en-us"}}"#,
    );
    assert!(read_config(invalid.path()).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_a_cancelled_synthesis_scope_removes_its_private_inputs() {
    let directory = configured();
    let root = directory.path().to_owned();
    let (send, read) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        let scratch = Scratch::create(&root).unwrap();
        private_write(&scratch.0.join("memo.txt"), "Exact text\n原文".as_bytes()).unwrap();
        send.send(scratch.0.clone()).unwrap();
        std::future::pending::<()>().await;
    });
    let path = read.await.unwrap();
    assert_eq!(
        fs::read_to_string(path.join("memo.txt")).unwrap(),
        "Exact text\n原文"
    );
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert!(!path.exists());
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "Requires installed macOS Samantha and Tingting voices"]
async fn installed_voices_emit_real_english_and_chinese_pcm() {
    let directory = configured();
    assert!(available(directory.path()));
    for (locale, content) in [
        ("en-US", "This is an offline OpenBot voice memo."),
        ("zh-CN", "这是一条离线语音便笺。"),
    ] {
        let generated = synthesize(directory.path(), content, locale)
            .await
            .unwrap_or_else(|error| panic!("Local speech synthesis failed: {}", error.code));
        assert!(generated.duration_ms > 100);
        assert!(generated.duration_ms <= 60_000);
        assert_eq!(
            canonical_wave(&generated.bytes).unwrap().bytes,
            generated.bytes
        );
    }
    let temporary = directory.path().join("speech/memo-temporary");
    assert_eq!(fs::read_dir(temporary).unwrap().count(), 0);
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "Requires /usr/bin/espeak-ng and its Mandarin and US English voices"]
async fn espeak_emits_real_english_and_chinese_pcm() {
    let directory = with_config(ESPEAK_CONFIG);
    assert!(available(directory.path()));
    for (locale, content) in [
        ("en-US", "This is an offline OpenBot voice memo."),
        ("zh-CN", "这是一条离线语音便笺。"),
    ] {
        let generated = synthesize(directory.path(), content, locale)
            .await
            .unwrap_or_else(|error| panic!("Local speech synthesis failed: {}", error.code));
        assert!(generated.duration_ms > 100);
        assert!(generated.duration_ms <= 60_000);
        assert_eq!(
            canonical_wave(&generated.bytes).unwrap().bytes,
            generated.bytes
        );
    }
}
