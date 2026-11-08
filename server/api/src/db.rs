use crate::{
    config::Config,
    error::{ApiError, Result},
};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore, broadcast};

#[derive(Clone, Debug)]
pub struct SecurityChange {
    pub user_id: Option<String>,
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
}
#[derive(Clone)]
pub struct State {
    pub(crate) pool: SqlitePool,
    pub config: Arc<Config>,
    pub workspace: Arc<crate::workspace::WorkspaceRegistry>,
    pub shared_bots: Arc<crate::shared_bots::SharedBots>,
    pub bot_templates: Arc<crate::bot_templates::BotTemplates>,
    pub apps: Arc<crate::apps::AppsRuntime>,
    pub computer: Arc<crate::computer::ComputerRuntime>,
    pub speech: Arc<crate::speech::SpeechService>,
    pub teaching: Arc<crate::teaching::TeachingRuntime>,
    pub agent_runs: Arc<crate::agent::AgentRegistry>,
    pub scheduler: Arc<crate::scheduling::Scheduler>,
    pub updates: Arc<crate::updates::Updates>,
    pub(crate) hash_slots: Arc<Semaphore>,
    pub(crate) website_share_limits: Arc<crate::workspace::website_shares::ReadLimits>,
    pub(crate) changes: broadcast::Sender<SecurityChange>,
    closing: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    close_lock: Arc<Mutex<()>>,
}
impl State {
    pub async fn open(config: Config) -> Result<Self> {
        config.validate()?;
        let directory = config.data_dir.join("platform");
        secure_directory(&config.data_dir)?;
        secure_directory(&directory)?;
        let file = directory.join("identity.sqlite");
        if file.exists() && !std::fs::symlink_metadata(&file)?.file_type().is_file() {
            return Err(ApiError::bad("账户存储路径不可用。"));
        }
        // Create with private permissions before SQLite opens the file.
        let mut create = std::fs::OpenOptions::new();
        create.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            create.mode(0o600);
        }
        match create.open(&file) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        private_file(&file)?;
        let options = SqliteConnectOptions::new()
            .filename(&file)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS app_oauth_index(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,storage_key TEXT NOT NULL,state_hash TEXT UNIQUE)").execute(&pool).await?;
        let (changes, _) = broadcast::channel(128);
        let workspace = Arc::new(crate::workspace::WorkspaceRegistry::new(
            config.data_dir.clone(),
        ));
        let shared_bots = Arc::new(crate::shared_bots::SharedBots::open(&config.data_dir).await?);
        let bot_templates =
            Arc::new(crate::bot_templates::BotTemplates::open(&config.data_dir).await?);
        Ok(Self {
            pool,
            config: Arc::new(config),
            workspace,
            shared_bots,
            bot_templates,
            apps: Arc::new(crate::apps::AppsRuntime::default()),
            computer: Arc::new(crate::computer::ComputerRuntime::default()),
            speech: Arc::new(crate::speech::SpeechService::default()),
            teaching: Arc::new(crate::teaching::TeachingRuntime::default()),
            agent_runs: Arc::new(crate::agent::AgentRegistry::default()),
            scheduler: Arc::new(crate::scheduling::Scheduler::default()),
            updates: Arc::new(crate::updates::Updates::default()),
            hash_slots: Arc::new(Semaphore::new(4)),
            website_share_limits: Arc::new(crate::workspace::website_shares::ReadLimits::default()),
            changes,
            closing: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
            close_lock: Arc::new(Mutex::new(())),
        })
    }
    pub async fn close(&self) {
        self.closing.store(true, Ordering::Release);
        self.changed(None, None, None);
        let _close = self.close_lock.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        self.scheduler.close().await;
        self.teaching.close().await;
        self.speech.close().await;
        self.apps.close(self).await;
        self.computer.close().await;
        self.agent_runs.shutdown().await;
        self.workspace.close().await;
        self.shared_bots.close().await;
        self.bot_templates.close().await;
        self.pool.close().await;
        self.closed.store(true, Ordering::Release);
    }
    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }
    pub fn subscribe_security(&self) -> broadcast::Receiver<SecurityChange> {
        self.changes.subscribe()
    }
    pub(crate) fn changed(
        &self,
        user: Option<String>,
        workspace: Option<String>,
        session: Option<String>,
    ) {
        let _ = self.changes.send(SecurityChange {
            user_id: user,
            workspace_id: workspace,
            session_id: session,
        });
    }
}
fn secure_directory(path: &Path) -> Result<()> {
    if path.exists() {
        if !std::fs::symlink_metadata(path)?.file_type().is_dir() {
            return Err(ApiError::bad("账户存储目录不可用。"));
        }
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
pub(crate) fn private_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(crate) fn iso(value: i64) -> String {
    chrono::DateTime::from_timestamp_millis(value)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
