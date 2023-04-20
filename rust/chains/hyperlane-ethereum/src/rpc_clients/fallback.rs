use std::fmt::{Debug, Formatter};
use std::time::Duration;

use async_trait::async_trait;
use ethers::providers::{Http, JsonRpcClient, ProviderError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{instrument, warn_span};

use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClient;

use crate::rpc_clients::{categorize_client_response, CategorizedResponse};

/// A provider that bundles multiple providers and attempts to call the first,
/// then the second, and so on until a response is received.
#[derive(Clone)]
pub struct FallbackProvider<T>(
    /// Sorted list of providers this provider calls in order of most primary to
    /// most fallback.
    Vec<T>,
);

impl Debug for FallbackProvider<PrometheusJsonRpcClient<Http>> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "FallbackProvider {{ chain_name: {}, hosts: [{}] }}",
            self.0.get(0).map(|v| v.chain_name()).unwrap_or("None"),
            self.0
                .iter()
                .map(|v| v.node_host())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

impl<T> FallbackProvider<T> {
    /// Convenience method for creating a `FallbackProviderBuilder` with same
    /// `JsonRpcClient` types
    pub fn builder() -> FallbackProviderBuilder<T> {
        FallbackProviderBuilder::default()
    }

    /// Create a new fallback provider
    pub fn new(providers: impl IntoIterator<Item = T>) -> Self {
        Self::builder().add_providers(providers).build()
    }
}

/// Builder to create a new fallback provider.
#[derive(Debug, Clone)]
pub struct FallbackProviderBuilder<T> {
    providers: Vec<T>,
}

impl<T> Default for FallbackProviderBuilder<T> {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
        }
    }
}

impl<T> FallbackProviderBuilder<T> {
    /// Add a new provider to the set. Each new provider will be a lower
    /// priority than the previous.
    pub fn add_provider(mut self, provider: T) -> Self {
        self.providers.push(provider);
        self
    }

    /// Add many providers sorted by highest priority to lowest.
    pub fn add_providers(mut self, providers: impl IntoIterator<Item = T>) -> Self {
        self.providers.extend(providers);
        self
    }

    /// Create a fallback provider.
    pub fn build(self) -> FallbackProvider<T> {
        FallbackProvider(self.providers)
    }
}

/// Errors specific to fallback provider.
#[derive(Error, Debug)]
pub enum FallbackError {
    /// All providers failed
    #[error("All providers failed. (Errors: {0:?})")]
    AllProvidersFailed(Vec<ProviderError>),
}

impl From<FallbackError> for ProviderError {
    fn from(src: FallbackError) -> Self {
        ProviderError::JsonRpcClientError(Box::new(src))
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl JsonRpcClient for FallbackProvider<PrometheusJsonRpcClient<Http>> {
    type Error = ProviderError;

    #[instrument]
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        use CategorizedResponse::*;

        let params = serde_json::to_value(params).expect("valid");

        let mut errors = vec![];
        // make sure we do at least 4 total retries.
        while errors.len() <= 3 {
            if !errors.is_empty() {
                sleep(Duration::from_millis(100)).await;
            }
            for (idx, provider) in self.0.iter().enumerate() {
                let fut = match params {
                    Value::Null => provider.request(method, ()),
                    _ => provider.request(method, &params),
                };

                let resp = fut.await;
                let _span =
                    warn_span!("request_with_fallback", provider_index=%idx, ?provider).entered();
                match categorize_client_response(method, resp) {
                    IsOk(v) => return Ok(serde_json::from_value(v)?),
                    RetryableErr(e) | RateLimitErr(e) => errors.push(e.into()),
                    NonRetryableErr(e) => return Err(e.into()),
                }
            }
        }

        Err(FallbackError::AllProvidersFailed(errors).into())
    }
}
