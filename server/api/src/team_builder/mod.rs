mod catalog;
mod draft;
mod jobs;
mod live;
mod mutations;
mod planning;
mod proposals;
mod routes;
mod starters;
mod store;
pub use jobs::TeamBuilderJobs;
pub use proposals::{ProposalContext, propose};
pub use store::initialize;

pub fn router() -> axum::Router<crate::db::State> {
    use axum::{
        extract::DefaultBodyLimit,
        routing::{get, post},
    };
    axum::Router::new()
        .route(
            "/api/workspaces/{wid}/bot-team-plans",
            get(routes::list).post(planning::create),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-templates",
            get(starters::list),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-plans/{id}",
            get(routes::get),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-plans/{id}/cancel",
            post(routes::cancel),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-plans/{id}/revise",
            post(routes::revise),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-plans/{id}/commit",
            post(routes::commit),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-plans/{id}/review-bots",
            post(routes::review),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-plans/{id}/refresh-bots",
            post(routes::refresh),
        )
        .route(
            "/api/workspaces/{wid}/bot-team-plans/{id}/catalog-refreshes/{request}",
            get(routes::receipt),
        )
        .layer(DefaultBodyLimit::max(136 * 1024))
}
