use crate::{
    db::State,
    error::{ApiError, Result},
    password,
};
use std::io::Write;

impl State {
    /// Explicit provisioning only; normal startup never replaces an existing setup code.
    pub async fn provision_operator(&self) -> Result<std::path::PathBuf> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE platform_role='admin'")
            .fetch_one(&mut *tx)
            .await?
            != 0
        {
            return Err(ApiError::new(409, "运营平台已经初始化。"));
        }
        let path = self.config.data_dir.join("platform/operator-setup-code");
        let existing = sqlx::query_scalar::<_, String>(
            "SELECT value FROM platform_meta WHERE key='setup_hash'",
        )
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(hash) = existing {
            let stat = std::fs::symlink_metadata(&path)?;
            if !stat.file_type().is_file() || stat.len() > 200 {
                return Err(ApiError::bad("初始化码文件不可用。"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if stat.permissions().mode() & 0o077 != 0 {
                    return Err(ApiError::bad("初始化码文件权限无效。"));
                }
            }
            let value = std::fs::read_to_string(&path)?;
            if password::digest(value.trim()) != hash {
                return Err(ApiError::bad("初始化码与身份库不一致。"));
            }
            tx.commit().await?;
            return Ok(path);
        }
        let value = password::token();
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        writeln!(file, "{value}")?;
        file.sync_all()?;
        sqlx::query("INSERT INTO platform_meta VALUES('setup_hash',?)")
            .bind(password::digest(&value))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(path)
    }
}
