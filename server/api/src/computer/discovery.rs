use super::{
    model::{self, Health, SavedRemote, ScreenBinding},
    response::read,
    transport::Authority,
};
use crate::error::Result;
use reqwest::Client;
use std::time::Duration;

pub(super) async fn discover(
    url: &str,
    token: &str,
    workspace: &str,
    origin: Option<&str>,
    binding: Option<&ScreenBinding>,
    expected: Option<&SavedRemote>,
    authorize: &Authority,
) -> Result<(Client, Health)> {
    model::validate_token(token)?;
    let url = model::worker_url(url)?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| model::invalid())?;
    authorize().await?;
    let prefix = binding
        .map(|b| format!("/screens/{}", b.screen_id))
        .unwrap_or_default();
    let mut request = client
        .get(format!("{url}{prefix}/health"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(8));
    if let Some(b) = binding {
        b.validate()?;
        request = request
            .header("X-OpenBot-Screen-Id", &b.screen_id)
            .header("X-OpenBot-Workspace-Scope", workspace);
        if let Some(revision) = &b.screen_revision {
            request = request.header("X-OpenBot-Screen-Revision", revision);
        }
    }
    if let Some(expected) = expected {
        request = request
            .header("X-OpenBot-Worker-Instance", &expected.instance_id)
            .header(
                "X-OpenBot-Control-Origin",
                expected.control_origin.as_deref().unwrap_or("none"),
            );
    }
    let reply = read(
        request.send().await.map_err(|_| model::invalid())?,
        64 * 1024,
    )
    .await?;
    if reply.status != 200 {
        return Err(model::invalid());
    }
    let health = model::health(
        reply.json()?,
        &url,
        token,
        workspace,
        origin,
        expected,
        binding,
        None,
    )?;
    authorize().await?;
    Ok((client, health))
}
