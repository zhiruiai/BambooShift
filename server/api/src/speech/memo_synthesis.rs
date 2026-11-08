use crate::error::{ApiError, Result};
use serde::Deserialize;
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::Semaphore,
};

#[path = "memo_espeak.rs"]
mod espeak;

pub(crate) const MAX_TEXT_UNITS: usize = 500;
const MAX_CONFIG: usize = 4096;
const MAX_CATALOG: usize = 64 * 1024;
const CATALOG_TIMEOUT: Duration = Duration::from_secs(5);
const SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(25);
static SYNTHESIS_SLOTS: Semaphore = Semaphore::const_new(2);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version: u8,
    enabled: bool,
    #[serde(default)]
    engine: Engine,
    voices: Voices,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Engine {
    #[default]
    MacosSay,
    EspeakNg,
}

impl Engine {
    fn executable(self) -> Option<&'static str> {
        let path = match self {
            Self::MacosSay if cfg!(target_os = "macos") => "/usr/bin/say",
            Self::EspeakNg if cfg!(target_os = "linux") => "/usr/bin/espeak-ng",
            _ => return None,
        };
        fs::metadata(path)
            .is_ok_and(|meta| meta.is_file())
            .then_some(path)
    }

    fn wave_limit(self) -> usize {
        match self {
            Self::MacosSay => super::wav::MAX_BYTES,
            Self::EspeakNg => espeak::MAX_BYTES,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Voices {
    #[serde(rename = "zh-CN")]
    chinese: String,
    #[serde(rename = "en-US")]
    english: String,
}

#[derive(Clone, Copy)]
enum Locale {
    Chinese,
    English,
}

impl Locale {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "zh-CN" => Ok(Self::Chinese),
            "en-US" => Ok(Self::English),
            _ => Err(invalid_text()),
        }
    }

    fn installed_tag(self) -> &'static str {
        match self {
            Self::Chinese => "zh_CN",
            Self::English => "en_US",
        }
    }

    fn voice(self, voices: &Voices) -> &str {
        match self {
            Self::Chinese => &voices.chinese,
            Self::English => &voices.english,
        }
    }
}

pub(crate) struct SynthesizedMemo {
    pub bytes: Vec<u8>,
    pub duration_ms: u64,
}

pub(crate) fn available(data_dir: &Path) -> bool {
    read_config(data_dir).is_ok_and(|config| config.engine.executable().is_some())
}

pub(crate) async fn synthesize(
    data_dir: &Path,
    text: &str,
    locale: &str,
) -> Result<SynthesizedMemo> {
    validate_text(text)?;
    let locale = Locale::parse(locale)?;
    let config = read_config(data_dir)?;
    let engine = config.engine;
    let executable = engine.executable().ok_or_else(unavailable)?;
    let voice = locale.voice(&config.voices);
    let _permit = SYNTHESIS_SLOTS.try_acquire().map_err(|_| {
        ApiError::new(429, "本地语音合成正在处理其他请求。").with_code("VOICE_MEMO_BUSY")
    })?;
    let catalog = installed_voices(engine, executable).await?;
    let installed = match engine {
        Engine::MacosSay => has_voice(&catalog, voice, locale),
        Engine::EspeakNg => espeak::has_voice(&catalog, voice),
    };
    if !installed {
        return Err(unavailable());
    }

    let directory = Scratch::create(data_dir)?;
    let input = directory.0.join("memo.txt");
    let output = directory.0.join("memo.wav");
    private_write(&input, text.as_bytes()).map_err(|_| unavailable())?;
    private_write(&output, &[]).map_err(|_| unavailable())?;
    let mut command = command(executable);
    match engine {
        Engine::MacosSay => command.arg(format!("--voice={voice}")).args([
            "--file-format=WAVE",
            "--data-format=LEI16@16000",
            "--channels=1",
            "-o",
        ]),
        Engine::EspeakNg => command.args(["-b", "1", "-v", voice, "-w"]),
    };
    let mut child = command
        .arg(&output)
        .arg("-f")
        .arg(&input)
        .current_dir(&directory.0)
        .env("TMPDIR", &directory.0)
        .spawn()
        .map_err(|_| unavailable())?;
    let limit = engine.wave_limit();
    wait_for_wave(&mut child, &output, limit).await?;
    let generated = read_private_file(&output, limit).map_err(|_| invalid_audio())?;
    match engine {
        Engine::MacosSay => canonical_wave(&generated),
        Engine::EspeakNg => canonical_wave(&espeak::normalize(&generated)?),
    }
}

fn validate_text(text: &str) -> Result<()> {
    if text.trim().is_empty()
        || text.encode_utf16().count() > MAX_TEXT_UNITS
        || text.contains("[[")
        || text.contains("]]")
        || text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(invalid_text());
    }
    Ok(())
}

fn invalid_text() -> ApiError {
    ApiError::bad("请提供不超过 500 个字符的中英文语音便笺正文。")
        .with_code("VOICE_MEMO_INVALID_TEXT")
}

fn invalid_audio() -> ApiError {
    ApiError::new(502, "本地语音合成未生成有效音频。").with_code("VOICE_MEMO_INVALID_AUDIO")
}

fn unavailable() -> ApiError {
    ApiError::new(503, "本地语音合成或所选声线暂不可用。").with_code("VOICE_MEMO_UNAVAILABLE")
}

fn timeout() -> ApiError {
    ApiError::new(504, "本地语音合成超时，请缩短便笺正文。").with_code("VOICE_MEMO_TIMEOUT")
}

fn read_config(data_dir: &Path) -> Result<Config> {
    let path = data_dir.join("speech");
    check_directory(&path, false).map_err(|_| unavailable())?;
    let bytes = read_private_file(&path.join("memo-synthesis.json"), MAX_CONFIG)
        .map_err(|_| unavailable())?;
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if config.version != 1
        || !config.enabled
        || !valid_voice_name(&config.voices.chinese)
        || !valid_voice_name(&config.voices.english)
        || (matches!(config.engine, Engine::EspeakNg)
            && (config.voices.chinese != "cmn" || config.voices.english != "en-us"))
    {
        return Err(unavailable());
    }
    Ok(config)
}

fn valid_voice_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.trim() == name
        && !name.chars().any(char::is_control)
}

fn command(executable: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn installed_voices(engine: Engine, executable: &str) -> Result<String> {
    let mut command = command(executable);
    match engine {
        Engine::MacosSay => command.args(["-v", "?"]),
        Engine::EspeakNg => command.arg("--voices"),
    };
    let mut child = command
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| unavailable())?;
    let stdout = child.stdout.take().ok_or_else(unavailable)?;
    let mut bytes = Vec::new();
    tokio::time::timeout(CATALOG_TIMEOUT, async {
        stdout
            .take((MAX_CATALOG + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| unavailable())?;
        if bytes.len() > MAX_CATALOG || !child.wait().await.is_ok_and(|status| status.success()) {
            return Err(unavailable());
        }
        String::from_utf8(bytes).map_err(|_| unavailable())
    })
    .await
    .map_err(|_| unavailable())?
}

fn has_voice(catalog: &str, voice: &str, locale: Locale) -> bool {
    catalog.lines().any(|line| {
        line.split_once('#')
            .and_then(|(entry, _)| entry.trim_end().rsplit_once(char::is_whitespace))
            .is_some_and(|(name, tag)| name.trim_end() == voice && tag == locale.installed_tag())
    })
}

async fn wait_for_wave(child: &mut Child, output: &Path, limit: usize) -> Result<()> {
    let result = tokio::time::timeout(SYNTHESIS_TIMEOUT, async {
        let mut monitor = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                status = child.wait() => {
                    return if status.is_ok_and(|status| status.success()) {
                        Ok(())
                    } else {
                        Err(invalid_audio())
                    };
                }
                _ = monitor.tick() => {
                    if fs::symlink_metadata(output)
                        .is_ok_and(|meta| !meta.is_file() || meta.len() > limit as u64)
                    {
                        return Err(invalid_audio());
                    }
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err(timeout()));
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

fn canonical_wave(generated: &[u8]) -> Result<SynthesizedMemo> {
    let (bytes, duration_ms) = super::wav::parse(generated).map_err(|_| invalid_audio())?;
    if duration_ms == 0 {
        return Err(invalid_audio());
    }
    Ok(SynthesizedMemo { bytes, duration_ms })
}

struct Scratch(PathBuf);

impl Scratch {
    fn create(data_dir: &Path) -> Result<Self> {
        let root = data_dir.join("speech").join("memo-temporary");
        if let Err(error) = create_private_directory(&root) {
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(unavailable());
            }
        }
        check_directory(&root, true).map_err(|_| unavailable())?;
        let path = root.join(uuid::Uuid::new_v4().to_string());
        create_private_directory(&path).map_err(|_| unavailable())?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    let mut options = DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        options.mode(0o700);
    }
    options.create(path)
}

fn check_directory(path: &Path, private: bool) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || !owned_mode(&meta, if private { 0o077 } else { 0o022 }) {
        return Err(io::Error::other("Insecure speech directory"));
    }
    Ok(())
}

fn owned_mode(meta: &fs::Metadata, forbidden: u32) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.uid() == unsafe { libc::geteuid() } && meta.mode() & forbidden == 0
    }
    #[cfg(not(unix))]
    {
        let _ = (meta, forbidden);
        false
    }
}

fn read_private_file(path: &Path, max: usize) -> io::Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || !owned_mode(&meta, 0o077) || meta.len() > max as u64 {
        return Err(io::Error::other("Insecure or oversized speech file"));
    }
    let mut bytes = Vec::new();
    file.take((max + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(io::Error::other("Oversized speech file"));
    }
    Ok(bytes)
}

fn private_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

#[cfg(test)]
#[path = "memo_synthesis_tests.rs"]
mod tests;
