use async_trait::async_trait;
use reqwest::Client as ReqestClient;
use reqwest_utils::parse_custom_rpc_headers;
use serde::de::DeserializeOwned;

use hyperlane_core::{ChainCommunicationError, ChainResult};
use tokio::{runtime::Handle, task::block_in_place};
use url::Url;

use crate::provider::HttpClient;
use crate::HyperlaneAleoError;
use std::time::Duration;

// Default timeouts
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Base Http client that performs REST-ful queries
#[derive(Clone, Debug)]
pub struct BaseHttpClient {
    client: ReqestClient,
    base_url: String,
}

impl BaseHttpClient {
    pub fn new(base_url: Url) -> ChainResult<Self> {
        let (headers, url) =
            parse_custom_rpc_headers(&base_url).map_err(ChainCommunicationError::from_other)?;
        let client = ReqestClient::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(HyperlaneAleoError::from)?;
        Ok(Self {
            client,
            base_url: url.to_string().trim_end_matches("/").into(),
        })
    }

    pub fn with_timeouts(
        base_url: impl Into<String>,
        connect_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<Self, HyperlaneAleoError> {
        let client = ReqestClient::builder()
            .connect_timeout(connect_timeout)
            .timeout(request_timeout)
            .build()
            .map_err(HyperlaneAleoError::from)?;
        Ok(Self {
            client,
            base_url: base_url.into(),
        })
    }

    pub fn client(&self) -> &ReqestClient {
        &self.client
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

#[async_trait]
impl HttpClient for BaseHttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let url = format!("{}/{}", self.base_url, path);
        let query: serde_json::Value = query.into().unwrap_or_default();
        let response = self
            .client
            .get(&url)
            .query(&query)
            .send()
            .await
            .map_err(HyperlaneAleoError::from)?;
        let response = response
            .error_for_status()
            .map_err(HyperlaneAleoError::from)?;
        let json = response.json().await.map_err(HyperlaneAleoError::from)?;
        Ok(json)
    }

    /// Makes a blocking GET request to the API
    fn request_blocking<T: DeserializeOwned>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let url = format!("{}/{}", self.base_url, path);
        let query: serde_json::Value = query.into().unwrap_or_default();

        block_in_place(|| {
            Handle::current().block_on(async {
                let response = self
                    .client
                    .get(&url)
                    .query(&query)
                    .send()
                    .await
                    .map_err(HyperlaneAleoError::from)?;
                let response = response
                    .error_for_status()
                    .map_err(HyperlaneAleoError::from)?;
                response
                    .json::<T>()
                    .await
                    .map_err(HyperlaneAleoError::from)
                    .map_err(ChainCommunicationError::from)
            })
        })
    }

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned>(
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
            .map_err(HyperlaneAleoError::from)?;
        let response = response
            .error_for_status()
            .map_err(HyperlaneAleoError::from)?;
        Ok(response.json().await.map_err(HyperlaneAleoError::from)?)
    }
}
