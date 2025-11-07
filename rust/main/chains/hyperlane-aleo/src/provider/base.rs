use async_trait::async_trait;
use derive_new::new;
use reqwest::Client as ReqestClient;
use serde::de::DeserializeOwned;

use hyperlane_core::ChainResult;

use crate::{provider::HttpClient, HyperlaneAleoError};

/// Base Http client that performs REST-ful queries
#[derive(Clone, Debug, new)]
pub struct BaseHttpClient {
    client: ReqestClient,
    base_url: String,
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
