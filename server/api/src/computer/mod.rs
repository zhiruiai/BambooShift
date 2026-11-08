pub mod action_store;
pub mod approvals;
pub mod cloud;
pub mod cloud_config;
pub mod cloud_provider;
pub mod controller;
pub mod controls;
pub mod frames;
mod job_retirement;
pub mod lifecycle;
pub mod local_executor;
pub mod model;
pub mod private_config;
pub mod reconnect;
mod response;
pub mod routes;
pub mod screen_bindings;
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
            "/api/workspaces/{wid}/computer/{*tail}",
            axum::routing::any(routes::dispatch),
        )
}
