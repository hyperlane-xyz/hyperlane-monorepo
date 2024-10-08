use std::time::Duration;

use eyre::Result;
use rusoto_core::{HttpClient, HttpConfig};

/// See https://github.com/hyperium/hyper/issues/2136#issuecomment-589488526
pub const HYPER_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Create a new HTTP client with a timeout for the connection pool.
/// This is a workaround for https://github.com/hyperium/hyper/issues/2136#issuecomment-589345238
pub fn http_client_with_timeout() -> Result<HttpClient> {
    let mut config = HttpConfig::new();
    config.pool_idle_timeout(HYPER_POOL_IDLE_TIMEOUT);
    Ok(HttpClient::new_with_config(config)?)
}
