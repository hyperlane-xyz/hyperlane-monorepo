use std::fmt::{Debug, Formatter};
use std::future::Future;
use std::ops::Deref;
use std::time::Duration;

use async_trait::async_trait;
use derive_new::new;
use ethers::providers::{HttpClientError, JsonRpcClient, ProviderError};
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{instrument, warn, warn_span};

use ethers_prometheus::json_rpc_client::JsonRpcBlockGetter;
use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use hyperlane_metric::prometheus_metric::PrometheusConfigExt;

use crate::rpc_clients::{categorize_client_response, CategorizedResponse};

const METHOD_SEND_RAW_TRANSACTION: &str = "eth_sendRawTransaction";

/// Wrapper of `FallbackProvider` for use in `hyperlane-ethereum`
/// The wrapper uses two distinct strategies to place requests to chains:
/// 1. multicast - the request will be sent to all the providers simultaneously and the first
///                successful response will be used.
/// 2. fallback  - the request will be sent to each provider one by one according to their
///                priority and the priority will be updated depending on success/failure.
///
/// Multicast strategy is used to submit transactions into the chain, namely with RPC method
/// `eth_sendRawTransaction` while fallback strategy is used for all the other RPC methods.
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
    C: JsonRpcClient + PrometheusConfigExt,
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
        + PrometheusConfigExt
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
        if method == METHOD_SEND_RAW_TRANSACTION {
            self.multicast(method, params).await
        } else {
            self.fallback(method, params).await
        }
    }
}

impl<C> EthereumFallbackProvider<C, JsonRpcBlockGetter<C>>
where
    C: JsonRpcClient<Error = HttpClientError>
        + Into<JsonRpcBlockGetter<C>>
        + PrometheusConfigExt
        + Clone,
    JsonRpcBlockGetter<C>: BlockNumberGetter,
{
    async fn multicast<T, R>(&self, method: &str, params: T) -> Result<R, ProviderError>
    where
        T: Serialize,
        R: DeserializeOwned,
    {
        use CategorizedResponse::*;

        let params = serde_json::to_value(params).expect("valid");

        // retryable errors reported by providers
        let mut retryable_errors = vec![];

        // non-retryable errors reported by providers
        let mut non_retryable_errors = vec![];

        // retry 4 times if all providers returned a retryable error
        for i in 0..=3 {
            if i > 0 {
                // sleep starting from the second attempt
                sleep(Duration::from_millis(100)).await;
            }

            // future which visits all providers as they fulfill their requests
            let mut unordered = self.populate_unordered_future(method, &params);

            while let Some(resp) = unordered.next().await {
                let value = match categorize_client_response(method, resp) {
                    IsOk(v) => serde_json::from_value(v)?,
                    RetryableErr(e) | RateLimitErr(e) => {
                        retryable_errors.push(e.into());
                        continue;
                    }
                    NonRetryableErr(e) => {
                        non_retryable_errors.push(e.into());
                        continue;
                    }
                };

                // if we are here, it means one of the providers returned a successful result
                if !retryable_errors.is_empty() || !non_retryable_errors.is_empty() {
                    // we log a warning if we got errors from failed providers
                    warn!(errors_count=?(retryable_errors.len() + non_retryable_errors.len()),  ?retryable_errors, ?non_retryable_errors, providers=?self.inner.providers, "multicast_request");
                }

                return Ok(value);
            }

            // if we are here, it means that all providers failed
            // if one of the errors was non-retryable, we stop doing retrying attempts
            if !non_retryable_errors.is_empty() {
                break;
            }
        }

        // we don't add a warning with all errors since an error will be logged later on
        retryable_errors.extend(non_retryable_errors);
        Err(FallbackError::AllProvidersFailed(retryable_errors).into())
    }

    async fn fallback<T, R>(&self, method: &str, params: T) -> Result<R, ProviderError>
    where
        T: Serialize,
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
            let priorities_snapshot = self.take_priorities_snapshot().await;
            for (idx, priority) in priorities_snapshot.iter().enumerate() {
                let provider = &self.inner.providers[priority.index];
                let fut = Self::provider_request(provider, method, &params);
                let resp = fut.await;
                self.handle_stalled_provider(priority, provider).await;
                let _span =
                    warn_span!("fallback_request", fallback_count=%idx, provider_index=%priority.index, ?provider).entered();

                match categorize_client_response(method, resp) {
                    IsOk(v) => return Ok(serde_json::from_value(v)?),
                    RetryableErr(e) | RateLimitErr(e) => errors.push(e.into()),
                    NonRetryableErr(e) => return Err(e.into()),
                }
            }
        }

        Err(FallbackError::AllProvidersFailed(errors).into())
    }

    async fn provider_request<'a>(
        provider: &'a C,
        method: &'a str,
        params: &'a Value,
    ) -> Result<Value, HttpClientError> {
        match params {
            Value::Null => provider.request(method, ()).await,
            _ => provider.request(method, params).await,
        }
    }

    fn populate_unordered_future<'a>(
        &'a self,
        method: &'a str,
        params: &'a Value,
    ) -> FuturesUnordered<impl Future<Output = Result<Value, HttpClientError>> + Sized + 'a> {
        let unordered = FuturesUnordered::new();
        self.inner
            .providers
            .iter()
            .for_each(|p| unordered.push(Self::provider_request(p, method, params)));
        unordered
    }
}

#[cfg(test)]
mod tests;
