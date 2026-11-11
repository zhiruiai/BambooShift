mod release;
mod routes;
mod version;
use crate::{
    db::{State, iso, now},
    error::{ApiError, Result},
    workspace::access::WorkspaceAccess,
};
use release::{Release, ReleaseClient};
pub use release::{ReleasesConfig, valid_repository};
pub use routes::router;
use serde_json::{Value, json};
use tokio::sync::Mutex;

#[derive(Clone)]
struct Checked {
    at: i64,
    fetched: std::time::Instant,
    result: std::result::Result<Release, &'static str>,
}
#[derive(Default)]
pub struct Updates {
    cache: Mutex<Option<Checked>>,
    checking: Mutex<()>,
    #[cfg(test)]
    client: Option<ReleaseClient>,
}
impl Updates {
    pub async fn status(&self, state: &State) -> Value {
        self.project(state, self.cache.lock().await.clone())
    }
    fn project(&self, state: &State, checked: Option<Checked>) -> Value {
        let repository = state
            .config
            .releases
            .as_ref()
            .map(ReleasesConfig::canonical_repository);
        let (status, reason, release) = match (repository, checked.as_ref()) {
            (None, _) => ("unconfigured", None, None),
            (Some(_), None) => ("unavailable", Some("not_checked"), None),
            (
                Some(_),
                Some(Checked {
                    result: Err(reason),
                    ..
                }),
            ) => ("unavailable", Some(*reason), None),
            (
                Some(_),
                Some(Checked {
                    result: Ok(release),
                    ..
                }),
            ) => (
                version::status(env!("CARGO_PKG_VERSION"), release.version.as_deref()),
                None,
                Some(release),
            ),
        };
        json!({"repository":repository,"serviceVersion":env!("CARGO_PKG_VERSION"),"status":status,"reason":reason,"release":release,"checkedAt":checked.map(|entry|iso(entry.at))})
    }
    pub async fn check(&self, state: &State, access: &WorkspaceAccess) -> Result<Value> {
        let _lease = self.checking.lock().await;
        access.authorize(state).await?;
        if state.is_closing() {
            return Err(ApiError::new(503, "服务正在结束，请稍后重试。"));
        }
        let Some(config) = &state.config.releases else {
            return Ok(self.status(state).await);
        };
        let previous = self.cache.lock().await.clone();
        if previous
            .as_ref()
            .is_some_and(|value| value.fetched.elapsed() < std::time::Duration::from_secs(300))
        {
            return Ok(self.project(state, previous));
        }
        let repository = config.canonical_repository();
        let production = ReleaseClient::new(repository);
        #[cfg(test)]
        let client = self.client.as_ref().or(production.as_ref().ok());
        #[cfg(not(test))]
        let client = production.as_ref().ok();
        let mut changes = state.subscribe_security();
        let result = if let Some(client) = client {
            let request = client.fetch(repository);
            tokio::pin!(request);
            loop {
                tokio::select! {
                    result = &mut request => break result,
                    _ = changes.recv() => {
                        if state.is_closing() { return Err(ApiError::new(503,"服务正在结束，请稍后重试。")); }
                        access.authorize(state).await?;
                    }
                }
            }
        } else {
            Err("network")
        };
        access.authorize(state).await?;
        let checked = Checked {
            at: now(),
            fetched: std::time::Instant::now(),
            result,
        };
        *self.cache.lock().await = Some(checked.clone());
        Ok(self.project(state, Some(checked)))
    }
}
#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod tests;
