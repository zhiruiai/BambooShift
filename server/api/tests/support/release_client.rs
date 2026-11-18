use super::ReleaseClient;
use std::time::Duration;

impl ReleaseClient {
    pub(in crate::updates) fn fixture(endpoint: String, timeout: Duration) -> Self {
        Self::build(endpoint, timeout).unwrap()
    }
}
