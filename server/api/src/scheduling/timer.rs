use super::{execution, primary};
use crate::{
    db::{State, now},
    error::Result,
    workspace::{Table, WorkspaceStore, time_zone},
};
use serde_json::json;
use sqlx::Row;
use tokio::sync::{Mutex, watch};

#[derive(Default)]
pub struct Scheduler {
    task: Mutex<Option<(watch::Sender<bool>, tokio::task::JoinHandle<()>)>>,
}
impl Scheduler {
    pub async fn is_running(&self) -> bool {
        self.task
            .lock()
            .await
            .as_ref()
            .is_some_and(|(_, task)| !task.is_finished())
    }
    pub async fn start(&self, state: State) {
        let mut task = self.task.lock().await;
        if task.is_some() || state.agent_runs.is_closed() {
            return;
        }
        let (stop, mut receiver) = watch::channel(false);
        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _=receiver.changed()=>break,
                    _=interval.tick()=>{if state.agent_runs.is_closed(){break;}let _=tick(&state,now()).await;},
                }
            }
        });
        *task = Some((stop, handle));
    }
    pub async fn close(&self) {
        if let Some((stop, task)) = self.task.lock().await.take() {
            let _ = stop.send(true);
            let _ = task.await;
        }
    }
}
/// Reload initialized workspaces so scheduled work never depends on an open browser.
pub async fn tick(state: &State, at: i64) -> Result<()> {
    if state.agent_runs.is_closed() {
        return Ok(());
    }
    let rows=sqlx::query("SELECT w.id,w.storage_key,w.kind FROM workspaces w JOIN memberships m ON m.workspace_id=w.id AND m.role='owner' JOIN users u ON u.id=m.user_id WHERE w.status='active' AND u.status='active'").fetch_all(&state.pool).await?;
    for row in rows {
        let wid: String = row.get("id");
        let key: String = row.get("storage_key");
        let kind: String = row.get("kind");
        let store = match state.workspace.get(&wid, &key).await {
            Ok(store) => store,
            Err(_) => continue,
        };
        let routines = match store.list(Table::Routines).await {
            Ok(routines) => routines,
            Err(_) => continue,
        };
        for routine in routines {
            if routine["enabled"] != true {
                continue;
            }
            let Some(due) = routine["nextRunAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|date| date.timestamp_millis())
            else {
                continue;
            };
            if due > at {
                continue;
            }
            let Some(schedule) = routine["schedule"].as_str() else {
                continue;
            };
            if matches!(
                time_zone::parse(schedule),
                Ok(time_zone::Schedule::Weekly(_, _))
            ) {
                let old = time_zone::local_day(due, routine.get("timeZone"));
                let current = time_zone::local_day(at, routine.get("timeZone"));
                if matches!((old,current),(Ok(old),Ok(current)) if old<current) {
                    let mut tx = store.begin().await?;
                    if let Some(mut actual) = WorkspaceStore::get_in(
                        &mut tx,
                        Table::Routines,
                        routine["id"].as_str().unwrap_or(""),
                    )
                    .await?
                    {
                        if actual == routine {
                            if let Ok(next) = time_zone::next(schedule, at, routine.get("timeZone"))
                            {
                                actual["nextRunAt"] = json!(next);
                                WorkspaceStore::put_in(&mut tx, Table::Routines, &actual).await?;
                                tx.commit().await?;
                                store.emit("update", json!({}));
                            }
                        }
                    }
                    continue;
                }
            }
            if crate::workspace::model::runtime_config(&store).await?["configured"] != true {
                continue;
            }
            let _ = execution::scheduled(state, &store, &routine, at).await;
        }
        let _ = primary::tick(state, &store, &kind, at).await;
    }
    Ok(())
}
