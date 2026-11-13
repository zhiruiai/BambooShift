pub mod access;
pub(crate) mod avatar_catalog;
pub(crate) mod avatar_jobs;
mod avatar_theme;
mod avatar_uploads;
pub(crate) mod avatars;
mod conversation_export;
mod conversation_markdown;
mod creation;
pub(crate) mod creation_preview;
mod credentials;
pub(crate) mod file_edits;
pub(crate) mod file_storage;
mod files;
pub(crate) mod groups;
mod knowledge;
pub mod model;
pub(crate) mod mutations;
mod overview;
pub(crate) mod primary;
mod private_skills;
pub(crate) mod profiles;
mod recovery;
mod registry;
mod roster;
mod seed;
mod session;
mod snapshot;
mod store;
mod team_skill_catalog;
mod team_skill_policy;
mod team_skill_publication;
mod team_skills;
pub mod time_zone;
mod time_zone_links;
mod unread;
mod usage;
pub(crate) mod website_projects;
pub(crate) mod website_shares;
mod website_zip;
pub use access::WorkspaceAccess;
pub use registry::WorkspaceRegistry;
pub use store::{Table, WorkspaceEvent, WorkspaceStore};

pub fn router() -> axum::Router<crate::db::State> {
    use axum::routing::{delete, get, patch, post, put};
    axum::Router::new()
        .merge(website_shares::router())
        .merge(private_skills::router())
        .route("/api/workspaces/{wid}/auth/status", get(session::status))
        .route("/api/workspaces/{wid}/bootstrap", get(snapshot::bootstrap))
        .route("/api/workspaces/{wid}/usage", get(usage::get))
        .route(
            "/api/workspaces/{wid}/avatar-theme",
            get(avatar_theme::get).put(avatar_theme::put),
        )
        .route("/api/workspaces/{wid}/admin/overview", get(overview::get))
        .route(
            "/api/workspaces/{wid}/sidebar-roster",
            get(roster::get).put(roster::put),
        )
        .route("/api/workspaces/{wid}/events", get(snapshot::events))
        .route("/api/workspaces/{wid}/files", post(files::upload))
        .route(
            "/api/workspaces/{wid}/files/{id}/download",
            get(files::download),
        )
        .route("/api/workspaces/{wid}/files/{id}", delete(files::remove))
        .route(
            "/api/workspaces/{wid}/website-projects/{id}",
            get(website_projects::manifest),
        )
        .route(
            "/api/workspaces/{wid}/website-projects/{id}/files/{*path}",
            get(website_projects::file),
        )
        .route(
            "/api/workspaces/{wid}/website-projects/{id}/download",
            get(website_projects::download),
        )
        .route(
            "/api/workspaces/{wid}/workspace-time-zone",
            get(time_zone::get).put(time_zone::put),
        )
        .route(
            "/api/workspaces/{wid}/primary-bot",
            get(primary::get).put(primary::put),
        )
        .route("/api/workspaces/{wid}/bot-avatars/{id}", get(avatars::get))
        .route(
            "/api/workspaces/{wid}/bot-avatars",
            post(avatar_uploads::crop),
        )
        .route(
            "/api/workspaces/{wid}/bot-avatars/sources",
            post(avatar_uploads::stage),
        )
        .route(
            "/api/workspaces/{wid}/bot-avatars/sources/{id}",
            get(avatars::source).delete(avatars::drop_source),
        )
        .route("/api/workspaces/{wid}/agents", post(mutations::add_agent))
        .route(
            "/api/workspaces/{wid}/creation-preview",
            post(creation_preview::post),
        )
        .route(
            "/api/workspaces/{wid}/creation-requests",
            post(creation::post),
        )
        .route(
            "/api/workspaces/{wid}/creation-requests/{id}",
            get(creation::get),
        )
        .route(
            "/api/workspaces/{wid}/creation-requests/{id}/cancel",
            post(creation::cancel),
        )
        .route(
            "/api/workspaces/{wid}/agents/{id}",
            patch(mutations::edit_agent).delete(mutations::remove_agent),
        )
        .route("/api/workspaces/{wid}/conversations", post(groups::post))
        .route(
            "/api/workspaces/{wid}/conversations/{id}/export",
            get(conversation_export::get).head(conversation_export::authorize),
        )
        .route(
            "/api/workspaces/{wid}/conversations/{id}",
            patch(groups::patch).delete(mutations::delete_chat),
        )
        .route(
            "/api/workspaces/{wid}/conversations/{id}/settings",
            get(groups::settings).patch(groups::edit_settings),
        )
        .route("/api/workspaces/{wid}/settings", put(model::put_settings))
        .route(
            "/api/workspaces/{wid}/model-profiles",
            get(model::get).post(model::post),
        )
        .route(
            "/api/workspaces/{wid}/model-profiles/{id}/activate",
            post(model::activate),
        )
        .route(
            "/api/workspaces/{wid}/model-profiles/{id}",
            delete(model::remove),
        )
        .route(
            "/api/workspaces/{wid}/memories",
            post(knowledge::add_memory),
        )
        .route(
            "/api/workspaces/{wid}/memories/{id}",
            patch(knowledge::edit_memory).delete(knowledge::delete_memory),
        )
        .route("/api/workspaces/{wid}/skills", post(knowledge::add_skill))
        .route(
            "/api/workspaces/{wid}/skills/{id}",
            delete(knowledge::delete_skill),
        )
        .route(
            "/api/workspaces/{wid}/skills/{id}/{action}",
            post(knowledge::transition),
        )
        .merge(team_skills::router())
        .merge(team_skill_publication::router())
        .merge(team_skill_catalog::router())
        .merge(team_skill_policy::router())
}
