use super::{WorkspaceStore, store::private_directory};
use crate::error::{ApiError, Result};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;

pub struct WorkspaceRegistry {
    root: PathBuf,
    stores: Mutex<HashMap<String, (Arc<WorkspaceStore>, bool)>>,
    closed: AtomicBool,
}
impl WorkspaceRegistry {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            stores: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }
    pub async fn get(&self, id: &str, storage_key: &str) -> Result<Arc<WorkspaceStore>> {
        if uuid::Uuid::parse_str(id).is_err() || (storage_key != "legacy" && storage_key != id) {
            return Err(ApiError::new(409, "工作空间存储登记无效。"));
        }
        let mut stores = self.stores.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(503, "工作空间服务正在关闭。"));
        }
        let expected = if storage_key == "legacy" {
            self.root.clone()
        } else {
            self.root.join("spaces").join(storage_key)
        };
        if let Some((store, initialized)) = stores.get_mut(id) {
            if store.directory != expected {
                return Err(ApiError::new(
                    409,
                    "工作空间存储登记已变化，请重新启动服务。",
                ));
            }
            if !*initialized {
                crate::apps::store::initialize_attached(store).await?;
                super::seed::initialize(store).await?;
                *initialized = true;
            }
            return Ok(store.clone());
        }
        if stores
            .values()
            .any(|(store, _)| store.directory == expected)
        {
            return Err(ApiError::new(409, "工作空间存储不能重复绑定。"));
        }
        private_directory(&self.root)?;
        let directory = if storage_key == "legacy" {
            self.root.clone()
        } else {
            let spaces = self.root.join("spaces");
            private_directory(&spaces)?;
            spaces.join(storage_key)
        };
        let store = Arc::new(WorkspaceStore::open_bound(&directory, id).await?);
        super::seed::initialize(&store).await?;
        stores.insert(id.to_owned(), (store.clone(), true));
        Ok(store)
    }
    pub(crate) async fn attach_app_source(
        &self,
        id: &str,
        storage_key: &str,
    ) -> Result<Arc<WorkspaceStore>> {
        if uuid::Uuid::parse_str(id).is_err() || (storage_key != "legacy" && storage_key != id) {
            return Err(ApiError::new(409, "来源登记无效。"));
        }
        let mut stores = self.stores.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(ApiError::new(503, "服务正在关闭。"));
        }
        let parents = if storage_key == "legacy" {
            vec![self.root.clone()]
        } else {
            vec![
                self.root.clone(),
                self.root.join("spaces"),
                self.root.join("spaces").join(id),
            ]
        };
        for path in &parents {
            let meta = std::fs::symlink_metadata(path)?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(ApiError::new(409, "来源存储不可用。"));
            }
        }
        let expected = parents.last().unwrap();
        if let Some((store, _)) = stores.get(id) {
            if store.directory != *expected {
                return Err(ApiError::new(409, "来源存储登记已变化。"));
            }
            return Ok(store.clone());
        }
        if stores.values().any(|(s, _)| s.directory == *expected) {
            return Err(ApiError::new(409, "来源存储不能重复绑定。"));
        }
        let store = Arc::new(WorkspaceStore::attach_existing_for_apps(expected, id).await?);
        stores.insert(id.to_owned(), (store.clone(), false));
        Ok(store)
    }
    pub async fn emit_all(&self, event: &str, data: serde_json::Value) {
        for (store, _) in self.stores.lock().await.values() {
            store.emit(event, data.clone());
        }
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let stores = self.stores.lock().await;
        for (store, _) in stores.values() {
            store.close().await;
        }
    }
}
