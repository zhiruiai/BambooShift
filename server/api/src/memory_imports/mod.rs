mod routes;
mod store;
pub(crate) use store::{initialize, settle};
pub fn router() -> axum::Router<crate::db::State> {
    use axum::routing::get;
    axum::Router::new()
        .route(
            "/api/workspaces/{wid}/memory-imports",
            get(routes::readiness).post(routes::submit),
        )
        .route(
            "/api/workspaces/{wid}/memory-imports/{id}",
            get(routes::get),
        )
}
