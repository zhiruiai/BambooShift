use super::{Table, WorkspaceStore};
use crate::error::Result;
use serde_json::json;

pub async fn initialize(store: &WorkspaceStore) -> Result<()> {
    let _credentials = store.credential_lock.lock().await;
    let mut tx = store.begin().await?;
    super::model::initialize(&mut tx).await?;
    super::usage::initialize(&mut tx).await?;
    super::creation::initialize(&mut tx).await?;
    super::website_projects::initialize(&mut tx).await?;
    crate::bot_templates::initialize(&mut tx).await?;
    crate::team_builder::initialize(&mut tx).await?;
    super::roster::initialize(&mut tx).await?;
    crate::shared_bots::initialize(&mut tx).await?;
    super::avatars::initialize(&mut tx).await?;
    super::time_zone::initialize(&mut tx).await?;
    super::primary::initialize(&mut tx).await?;
    crate::scheduling::initialize(&mut tx).await?;
    crate::memory_imports::initialize(&mut tx).await?;
    crate::teaching::initialize(&mut tx).await?;
    super::credentials::migrate(store, &mut tx).await?;
    super::recovery::recover(&mut tx).await?;
    if WorkspaceStore::get_in(&mut tx, Table::Settings, "seeded")
        .await?
        .is_none()
        && WorkspaceStore::list_in(&mut tx, Table::Agents)
            .await?
            .is_empty()
    {
        let agent = uuid::Uuid::new_v4().to_string();
        let conversation = uuid::Uuid::new_v4().to_string();
        WorkspaceStore::put_in(&mut tx,Table::Agents,&json!({"id":agent,"name":"小欧","role":"你的工作搭档","description":"整理目标，协作完成工作。","instructions":"用自然简练的中文沟通，依据实际结果汇报。","color":"#8b5cf6","avatar":"orb","status":"idle","configRevision":uuid::Uuid::new_v4().to_string()})).await?;
        WorkspaceStore::put_in(&mut tx,Table::Conversations,&json!({"id":conversation,"title":"小欧","agentIds":[agent],"isGroup":false,"updatedAt":crate::db::iso(crate::db::now()),"unread":0,"pinned":false})).await?;
        WorkspaceStore::put_in(
            &mut tx,
            Table::Settings,
            &json!({"id":"seeded","value":true}),
        )
        .await?;
    }
    tx.commit().await?;
    super::credentials::collect(store).await?;
    Ok(())
}
