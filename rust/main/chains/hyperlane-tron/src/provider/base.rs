use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client as ReqwestClient;
use reqwest_utils::parse_custom_rpc_headers;
use serde::de::DeserializeOwned;
use url::Url;

use hyperlane_core::{ChainCommunicationError, ChainResult};

use crate::provider::traits::{HttpClient, HttpClientBuilder};
use crate::HyperlaneTronError;

/// Default timeouts
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Base Http client that performs REST-ful queries against Tron nodes
#[derive(Clone, Debug)]
pub struct TronBaseHttpClient {
    client: ReqwestClient,
    base_url: String,
}

impl TronBaseHttpClient {
    /// Create a new base HTTP client for a Tron node
    pub fn new(base_url: Url) -> ChainResult<Self> {
        let (headers, url) =
            parse_custom_rpc_headers(&base_url).map_err(ChainCommunicationError::from_other)?;
        let client = ReqwestClient::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(HyperlaneTronError::from)?;
        Ok(Self {
            client,
            base_url: url.to_string().trim_end_matches('/').to_string(),
        })
    }
}

#[async_trait]
impl HttpClient for TronBaseHttpClient {
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        let url = format!("{}/{}", self.base_url, path);
        let response = self
            .client
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(HyperlaneTronError::from)?;
        let response = response
            .error_for_status()
            .map_err(HyperlaneTronError::from)?;
        Ok(response.json().await.map_err(HyperlaneTronError::from)?)
    }
}

impl HttpClientBuilder for TronBaseHttpClient {
    type Client = TronBaseHttpClient;

    fn build(url: Url) -> ChainResult<Self::Client> {
        TronBaseHttpClient::new(url)
    }
}
