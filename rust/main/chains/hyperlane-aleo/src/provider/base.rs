use async_trait::async_trait;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::Client as ReqestClient;
use reqwest_utils::parse_custom_rpc_headers;
use serde::de::DeserializeOwned;

use hyperlane_core::{ChainCommunicationError, ChainResult};
use tokio::sync::RwLock;
use url::Url;

use crate::provider::{HttpClient, HttpClientBuilder};
use crate::HyperlaneAleoError;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

// Default timeouts
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Base Http client that performs REST-ful queries
#[derive(Clone, Debug)]
pub struct BaseHttpClient {
    client: ReqestClient,
    base_url: String,
}

impl BaseHttpClient {
    pub fn new(base_url: Url, network: u16) -> ChainResult<Self> {
        let (headers, url) =
            parse_custom_rpc_headers(&base_url).map_err(ChainCommunicationError::from_other)?;
        let client = ReqestClient::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(HyperlaneAleoError::from)?;
        let suffix = match network {
            0 => "mainnet",
            1 => "testnet",
            2 => "canary",
            id => return Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        };
        Ok(Self {
            client,
            base_url: url.to_string().trim_end_matches("/").to_string() + "/" + suffix,
        })
    }
}

#[async_trait]
impl HttpClient for BaseHttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
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

    /// Makes a POST request to the API
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
            .map_err(HyperlaneAleoError::from)?;
        let response = response
            .error_for_status()
            .map_err(HyperlaneAleoError::from)?;
        Ok(response.json().await.map_err(HyperlaneAleoError::from)?)
    }
}

impl HttpClientBuilder for BaseHttpClient {
    type Client = BaseHttpClient;

    fn build(url: Url, network: u16) -> ChainResult<Self::Client> {
        BaseHttpClient::new(url, network)
    }
}

/// Base Http client that performs REST-ful queries
#[derive(Clone, Debug)]
pub struct JWTBaseHttpClient {
    client: ReqestClient,
    base_url: String,
    suffix: String,
    auth_url: String,
    auth_token: Arc<RwLock<Option<(HeaderValue, Instant)>>>,
}

impl JWTBaseHttpClient {
    /// Creates a new Http client
    pub fn new(base_url: Url, network: u16) -> ChainResult<Self> {
        let (headers, url) =
            parse_custom_rpc_headers(&base_url).map_err(ChainCommunicationError::from_other)?;
        let auth_url = headers
            .get("x-auth-url")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let client = ReqestClient::builder()
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(HyperlaneAleoError::from)?;
        let suffix = match network {
            0 => "mainnet",
            1 => "testnet",
            2 => "canary",
            id => return Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        };
        Ok(Self {
            client,
            base_url: url.to_string().trim_end_matches("/").to_string(),
            auth_token: Default::default(),
            suffix: suffix.to_string(),
            auth_url,
        })
    }

    /// Gets the authentication token if it is still valid
    pub async fn get_auth_token(&self) -> ChainResult<HeaderValue> {
        {
            let auth_token = self.auth_token.read().await;
            if let Some((token, expires_at)) = &*auth_token {
                if Instant::now() < *expires_at {
                    return Ok(token.clone());
                }
            }
        }

        let response = self
            .client
            .post(&self.auth_url)
            .send()
            .await
            .map_err(HyperlaneAleoError::from)?;
        let result = response
            .headers()
            .get(AUTHORIZATION)
            .ok_or(HyperlaneAleoError::MissingAuthHeader)?
            .clone();
        let expires = Instant::now()
            .checked_add(Duration::from_secs(60 * 15))
            .unwrap_or(Instant::now()); // Tokens last 15 minutes
        let mut auth_token = self.auth_token.write().await;
        *auth_token = Some((result.clone(), expires));
        Ok(result.clone())
    }
}

#[async_trait]
impl HttpClient for JWTBaseHttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let url = format!("{}/{}/{}", self.base_url, self.suffix, path);
        let query: serde_json::Value = query.into().unwrap_or_default();
        let auth = self.get_auth_token().await?;
        let response = self
            .client
            .get(&url)
            .header(AUTHORIZATION, auth)
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

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        let url = format!("{}/{}/{}", self.base_url, self.suffix, path);
        let auth = self.get_auth_token().await?;
        let response = self
            .client
            .post(&url)
            .header(AUTHORIZATION, auth)
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

impl HttpClientBuilder for JWTBaseHttpClient {
    type Client = JWTBaseHttpClient;

    fn build(url: Url, network: u16) -> ChainResult<Self::Client> {
        JWTBaseHttpClient::new(url, network)
    }
}
