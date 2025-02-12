use std::fmt::{Debug, Formatter};
use std::ops::Deref;
use std::time::Duration;

use async_trait::async_trait;
use derive_new::new;
use ethers::providers::{HttpClientError, JsonRpcClient, ProviderError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{info, instrument, warn_span};

use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, PrometheusJsonRpcClientConfigExt};
use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};

use crate::rpc_clients::{categorize_client_response, CategorizedResponse};

/// Wrapper of `FallbackProvider` for use in `hyperlane-ethereum`
#[derive(new)]
pub struct EthereumFallbackProvider<C, B>(FallbackProvider<C, B>);

impl<C, B> Deref for EthereumFallbackProvider<C, B> {
    type Target = FallbackProvider<C, B>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<C, B> Debug for EthereumFallbackProvider<C, B>
where
    C: JsonRpcClient + PrometheusJsonRpcClientConfigExt,
{
    #[allow(clippy::get_first)] // TODO: `rustc` 1.80.1 clippy issue
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FallbackProvider")
            .field(
                "chain_name",
                &self
                    .inner
                    .providers
                    .get(0)
                    .map(|v| v.chain_name())
                    .unwrap_or("None"),
            )
            .field(
                "hosts",
                &self
                    .inner
                    .providers
                    .iter()
                    .map(|v| v.node_host())
                    .collect::<Vec<_>>()
                    .join(", "),
            )
            .finish()
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
impl<C> JsonRpcClient for EthereumFallbackProvider<C, JsonRpcBlockGetter<C>>
where
    C: JsonRpcClient<Error = HttpClientError>
        + Into<JsonRpcBlockGetter<C>>
        + PrometheusJsonRpcClientConfigExt
        + Clone,
    JsonRpcBlockGetter<C>: BlockNumberGetter,
{
    type Error = ProviderError;

    // TODO: Refactor to use `FallbackProvider::call`
    #[instrument]
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        use CategorizedResponse::*;

        info!(method, "EthereumFallBackProvider method");

        let params = serde_json::to_value(params).expect("valid");

        let mut errors = vec![];
        // make sure we do at least 4 total retries.
        while errors.len() <= 3 {
            if !errors.is_empty() {
                sleep(Duration::from_millis(100)).await;
            }
            let priorities_snapshot = self.take_priorities_snapshot().await;
            for (idx, priority) in priorities_snapshot.iter().enumerate() {
                let provider = &self.inner.providers[priority.index];
                let fut = Self::provider_request(provider, method, &params);
                let resp = fut.await;
                self.handle_stalled_provider(priority, provider).await;
                let _span =
                    warn_span!("request", fallback_count=%idx, provider_index=%priority.index, ?provider).entered();

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

impl<C, B> EthereumFallbackProvider<C, B>
where
    C: JsonRpcClient<Error = HttpClientError>,
{
    async fn provider_request<'a>(
        provider: &'a C,
        method: &'a str,
        params: &'a Value,
    ) -> Result<Value, HttpClientError> {
        match params {
            Value::Null => provider.request(method, ()).await,
            _ => provider.request(method, &params).await,
        }
    }
}

#[cfg(test)]
mod tests;
