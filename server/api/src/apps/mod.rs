mod action_execution;
pub mod actions;
mod bridge;
pub mod connections;
mod credentials;
mod endpoint;
pub mod interactive_policy;
mod interactive_rules;
pub mod model;
mod oauth;
mod oauth_callback;
mod oauth_store;
pub mod policies;
mod policy_data;
mod policy_routes;
pub(crate) mod policy_runtime;
pub(crate) mod provider_catalog;
mod routes;
mod runtime;
mod slack;
pub(crate) mod store;
mod tokens;
pub(crate) mod tool_access;
pub use runtime::{AppsRuntime, Authority, user_authority};

pub fn router() -> axum::Router<crate::db::State> {
    use axum::routing::{delete, get, post, put};
    axum::Router::new()
        .route(
            "/api/workspaces/{wid}/apps/approval-rules",
            get(interactive_rules::list),
        )
        .route(
            "/api/workspaces/{wid}/apps/approval-rules/{id}",
            delete(interactive_rules::revoke),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/policies",
            get(policy_routes::list).post(policy_routes::create),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/policies/options",
            get(policy_routes::options),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/policies/{policy}/revoke",
            post(policy_routes::revoke),
        )
        .route(
            "/api/workspaces/{wid}/apps",
            get(routes::list).post(routes::add),
        )
        .route("/api/workspaces/{wid}/apps/{id}", delete(routes::remove))
        .route("/api/workspaces/{wid}/apps/{id}/tools", get(routes::tools))
        .route(
            "/api/workspaces/{wid}/apps/{id}/tools/access",
            put(routes::tool_access),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/reconnect",
            post(routes::reconnect),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/disconnect",
            post(routes::disconnect),
        )
        .route(
            "/api/workspaces/{wid}/app-actions/{id}/decision",
            post(routes::decide),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/oauth",
            get(routes::oauth_current),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/oauth/start",
            post(routes::oauth_start),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/oauth/{fid}",
            get(routes::oauth_get),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/oauth/{fid}/handoff",
            get(routes::oauth_handoff),
        )
        .route(
            "/api/workspaces/{wid}/apps/{id}/oauth/{fid}/{operation}",
            post(routes::oauth_action),
        )
        .route("/api/app-oauth/callback", get(oauth_callback::callback))
        .route("/api/app-oauth/result", get(oauth_callback::result))
        .route(
            "/api/app-oauth/client-metadata",
            get(oauth_callback::metadata),
        )
}
