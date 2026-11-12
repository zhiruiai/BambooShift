use crate::{
    account_settings, accounts, db::State, error::ApiError, invitations, operator,
    operator_queries, security, workspaces,
};
use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    routing::{delete, get, patch, post},
};
use serde_json::json;

fn product() -> Router<State> {
    Router::new()
        .merge(crate::workspace::router())
        .merge(crate::apps::router())
        .merge(crate::computer::router())
        .merge(crate::speech::router())
        .merge(crate::updates::router())
        .merge(crate::agent::router())
        .merge(crate::scheduling::router())
        .merge(crate::memory_imports::router())
        .merge(crate::team_builder::router())
        .merge(crate::teaching::router())
        .merge(crate::shared_bots::router())
        .merge(crate::bot_templates::router())
        .route(
            "/api/health",
            get(|| async {
                Json(json!({"ok":true,"runtime":"pi","architecture":"platform","backend":"rust"}))
            }),
        )
        .route("/api/account/session", get(accounts::session))
        .route(
            "/api/account/local-session",
            post(crate::local_desktop::session),
        )
        .route("/api/account/register", post(accounts::register))
        .route("/api/account/login", post(accounts::login))
        .route("/api/account/logout", post(accounts::logout))
        .route("/api/account/profile", patch(account_settings::profile))
        .route(
            "/api/account/password",
            post(account_settings::change_password),
        )
        .route(
            "/api/account/sessions",
            get(account_settings::list_sessions),
        )
        .route(
            "/api/account/sessions/{id}",
            delete(account_settings::revoke_session),
        )
        .route("/api/account/workspaces", post(workspaces::create))
        .route("/api/account/workspaces/{id}", patch(workspaces::rename))
        .route("/api/account/workspaces/{id}/team", get(workspaces::team))
        .route(
            "/api/account/workspaces/{id}/invitations",
            post(invitations::create),
        )
        .route(
            "/api/account/workspaces/{id}/invitations/{invitation}",
            delete(invitations::revoke),
        )
        .route(
            "/api/account/workspaces/{id}/members/{user}",
            delete(workspaces::remove_member),
        )
        .route("/api/invitations/{token}", get(invitations::preview))
        .route("/api/invitations/{token}/accept", post(invitations::accept))
}

fn operations() -> Router<State> {
    Router::new()
        .route("/api/platform/session", get(operator::session))
        .route("/api/platform/setup", post(operator::setup))
        .route("/api/platform/login", post(operator::login))
        .route("/api/platform/logout", post(operator::logout))
        .route("/api/platform/overview", get(operator_queries::overview))
        .route("/api/platform/users", get(operator_queries::users))
        .route(
            "/api/platform/users/{id}",
            patch(operator_queries::set_user),
        )
        .route(
            "/api/platform/workspaces",
            get(operator_queries::workspaces),
        )
        .route(
            "/api/platform/workspaces/{id}",
            patch(operator_queries::set_workspace),
        )
}

fn finish(routes: Router<State>, state: State, operations: bool) -> Router {
    let routes = routes
        .method_not_allowed_fallback(|| async {
            ApiError::new(405, "此接口不支持该请求方式。")
        })
        .layer(DefaultBodyLimit::max(64 * 1024));
    let routes = if operations {
        routes.layer(axum::middleware::from_fn_with_state(
            state.clone(),
            security::operations_guard,
        ))
    } else {
        routes.layer(axum::middleware::from_fn_with_state(
            state.clone(),
            security::guard,
        ))
    };
    routes.with_state(state)
}

pub fn product_router(state: State) -> Router {
    finish(
        product().fallback(crate::web::product_fallback),
        state,
        false,
    )
}

pub fn operations_router(state: State) -> Router {
    finish(operations()
        .route("/api/health", get(|| async { Json(json!({"ok":true,"backend":"rust","architecture":"platform","surface":"operations"})) }))
        .fallback(crate::web::operations_fallback), state, true)
}

// Compatibility composition for existing embedded consumers and regression fixtures.
// The executable exclusively serves the two isolated routers above.
pub fn router(state: State) -> Router {
    finish(
        product().merge(operations()).fallback(crate::web::fallback),
        state,
        false,
    )
}
