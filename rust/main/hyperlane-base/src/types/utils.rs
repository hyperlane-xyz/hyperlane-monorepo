use std::time::Duration;

use eyre::Result;
use hyper::{client::HttpConnector, Client};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use rusoto_core::{HttpClient, HttpConfig};

/// See https://github.com/hyperium/hyper/issues/2136#issuecomment-589488526
pub const HYPER_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Create a new HTTP client with a timeout for the connection pool.
/// This is a workaround for https://github.com/hyperium/hyper/issues/2136#issuecomment-589345238
// pub fn http_client_with_timeout() -> Result<HttpClient> {
//     let mut config = HttpConfig::new();
//     config.pool_idle_timeout(HYPER_POOL_IDLE_TIMEOUT);
//     Ok(HttpClient::new_with_config(config)?)
// }

pub fn http_client_with_timeout() -> Result<HttpClient<HttpsConnector<HttpConnector>>> {
    // Build a connector that supports HTTPS and HTTP/2
    // let mut http = HttpConnector::new();
    // http.enforce_http(false);
    // let https_connector = HttpsConnector::builder().with_native_roots()
    let https_connector = HttpsConnectorBuilder::new()
        .with_native_roots()
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .build();

    // Build the hyper client builder
    let mut hyper_builder = Client::builder();
    hyper_builder
        .http2_adaptive_window(true)
        .pool_max_idle_per_host(20)
        .pool_idle_timeout(Duration::from_secs(20));

    // Build the full hyper client using the connector
    // let hyper_client = hyper_builder.build::<_, hyper::Body>(https_connector.clone());

    // ✅ Now pass both builder and connector to from_builder
    let http_client = HttpClient::from_builder(hyper_builder, https_connector);
    Ok(http_client)
    // S3Client::new_with(http_client, rusoto_credential::AnonymousCredentials::new(), Region::UsEast1)
}
