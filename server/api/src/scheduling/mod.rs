mod execution;
mod history;
mod operation_store;
mod operations;
mod primary;
pub(crate) mod public_research;
pub(crate) mod routines;
mod timer;
mod transfer_store;
mod transfers;
mod webhook_store;
mod webhooks;
pub(crate) use history::settle;
pub(crate) use webhooks::is_webhook_ingress;
pub(crate) async fn initialize(conn: &mut sqlx::SqliteConnection) -> crate::error::Result<()> {
    history::initialize(conn).await?;
    transfer_store::initialize(conn).await?;
    public_research::initialize(conn).await?;
    webhook_store::initialize(conn).await
}
pub(crate) use primary::status as primary_status;
pub use timer::{Scheduler, tick};

pub fn router() -> axum::Router<crate::db::State> {
    use axum::routing::{get, patch, post};
    axum::Router::new()
        .merge(webhooks::router())
        .route(
            "/api/workspaces/{wid}/routines/{id}/transfer",
            post(transfers::transfer),
        )
        .route(
            "/api/workspaces/{wid}/routine-transfers/{id}",
            get(transfers::get),
        )
        .route(
            "/api/workspaces/{wid}/routine-transfers/{id}/cancel",
            post(transfers::cancel),
        )
        .route(
            "/api/workspaces/{wid}/routine-operations",
            post(operations::submit),
        )
        .route(
            "/api/workspaces/{wid}/routine-operations/{id}",
            get(operations::get),
        )
        .route(
            "/api/workspaces/{wid}/routine-operations/{id}/cancel",
            post(operations::cancel),
        )
        .route("/api/workspaces/{wid}/routines", post(routines::create))
        .route(
            "/api/workspaces/{wid}/routines/{id}",
            patch(routines::edit).delete(routines::remove),
        )
        .route(
            "/api/workspaces/{wid}/routines/{id}/run",
            post(execution::manual),
        )
        .route(
            "/api/workspaces/{wid}/routines/{id}/runs",
            get(history::list),
        )
        .route(
            "/api/workspaces/{wid}/routines/{id}/runs/{run}",
            get(history::get),
        )
}
