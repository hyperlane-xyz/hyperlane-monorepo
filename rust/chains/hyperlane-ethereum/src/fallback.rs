use std::fmt::Debug;

use async_trait::async_trait;
use ethers::providers::{Http, HttpClientError, JsonRpcClient, ProviderError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tracing::warn;

use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClient;

const METHODS_TO_NOT_TO_FALLBACK_ON: &[&str] = &[
    "eth_estimateGas",
    "eth_sendTransaction",
    "eth_sendRawTransaction",
];

/// A provider that bundles multiple providers and attempts to call the first,
/// then the second, and so on until a response is received.
#[derive(Debug, Clone)]
pub struct FallbackProvider<T>(
    /// Sorted list of providers this provider calls in order of most primary to
    /// most fallback.
    Vec<T>,
);

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
    /// Add a new provider to the set. Each new provider will be a lower priority than the previous.
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

    async fn request<T: Serialize + Send + Sync, R: DeserializeOwned>(
        &self,
        method: &str,
        params: T,
    ) -> Result<R, Self::Error> {
        let params = serde_json::to_value(params).expect("valid");

        let mut errors = vec![];
        for (idx, provider) in self.0.iter().enumerate() {
            let fut = match params {
                Value::Null => provider.request(method, ()),
                _ => provider.request(method, &params),
            };

            match fut.await {
                Ok(v) => return Ok(serde_json::from_value(v)?),

                Err(HttpClientError::ReqwestError(e)) => {
                    warn!(error=%e, provider_index=%idx, ?provider, method, "ReqwestError in http provider; falling back to the next provider");
                    errors.push(HttpClientError::ReqwestError(e).into())
                }
                Err(HttpClientError::SerdeJson { err, text }) => {
                    warn!(error=%err, text, provider_index=%idx, ?provider, method, "ReqwestError in http provider; falling back to the next provider");
                    errors.push(HttpClientError::SerdeJson { err, text }.into())
                }
                Err(HttpClientError::JsonRpcError(e)) => {
                    if METHODS_TO_NOT_TO_FALLBACK_ON.contains(&method) {
                        warn!(error = %e, provider_index=%idx, ?provider, method, "JsonRpcError in http provider; not falling back");
                        return Err(HttpClientError::JsonRpcError(e).into());
                    } else {
                        warn!(error = %e, provider_index=%idx, ?provider, method, "JsonRpcError in http provider; falling back to the next provider");
                        errors.push(HttpClientError::JsonRpcError(e).into())
                    }
                }
            }
        }

        Err(FallbackError::AllProvidersFailed(errors).into())
    }
}
