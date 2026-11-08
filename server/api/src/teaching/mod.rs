mod generation;
mod recording;
mod routes;
mod runtime;
mod store;
mod validation;
pub(crate) use recording::{before_input, input_succeeded};
pub use runtime::TeachingRuntime;
pub use store::initialize;
pub fn router() -> axum::Router<crate::db::State> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route(
            "/api/workspaces/{wid}/teaching",
            get(routes::list).post(routes::start),
        )
        .route(
            "/api/workspaces/{wid}/teaching/{id}",
            get(routes::get).patch(routes::review),
        )
        .route(
            "/api/workspaces/{wid}/teaching/{id}/stop",
            post(routes::stop),
        )
        .route(
            "/api/workspaces/{wid}/teaching/{id}/cancel",
            post(routes::cancel),
        )
        .route(
            "/api/workspaces/{wid}/teaching/{id}/generate",
            post(generation::generate),
        )
}
