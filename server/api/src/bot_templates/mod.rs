pub(crate) mod blueprint;
mod copy_routes;
mod installs;
mod mutations;
mod projection;
mod public_routes;
mod published;
mod routes;
mod store;
pub use store::BotTemplates;

pub use installs::{InstallJobs, initialize};
pub fn router() -> axum::Router<crate::db::State> {
    use axum::routing::{get, post};
    axum::Router::new()
        .merge(routes::router())
        .route(
            "/api/workspaces/{wid}/bot-copy-source/{id}",
            get(copy_routes::source),
        )
        .route("/api/workspaces/{wid}/bot-copies", post(copy_routes::copy))
        .route(
            "/api/workspaces/{wid}/bot-copies/{id}",
            get(copy_routes::receipt),
        )
}
