pub(crate) mod accessibility;
mod action_execution;
pub mod action_store;
pub mod approvals;
pub(crate) mod authorization;
pub mod cloud;
pub mod cloud_config;
pub mod cloud_provider;
pub mod controller;
pub mod controls;
mod discovery;
pub mod frames;
mod job_retirement;
pub mod lifecycle;
pub mod local_executor;
mod local_surface;
pub mod model;
mod pairing;
pub mod private_config;
pub mod reconnect;
mod response;
pub mod routes;
pub mod screen_bindings;
pub(crate) mod skill_scripts;
mod takeover_frames;
pub mod tasks;
pub mod transfers;
pub mod transport;
pub mod validation;
pub use controller::ComputerRuntime;
pub fn router() -> axum::Router<crate::db::State> {
    axum::Router::new()
        .route(
            "/api/workspaces/{wid}/cloud-computer",
            axum::routing::get(routes::cloud_status),
        )
        .route(
            "/api/workspaces/{wid}/cloud-computer/start",
            axum::routing::post(routes::cloud_start),
        )
        .route(
            "/api/workspaces/{wid}/computer/connect/check",
            axum::routing::post(pairing::check)
                .layer(axum::extract::DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/workspaces/{wid}/computer/{*tail}",
            axum::routing::any(routes::dispatch),
        )
}
