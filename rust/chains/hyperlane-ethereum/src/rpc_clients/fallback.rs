use derive_new::new;
use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use std::fmt::{Debug, Formatter};
use std::ops::Deref;
use std::time::Duration;
use thiserror::Error;

use async_trait::async_trait;
use ethers::providers::{HttpClientError, JsonRpcClient, ProviderError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tokio::time::sleep;
use tracing::{instrument, warn_span};

use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClientConfigExt;

use crate::rpc_clients::{categorize_client_response, CategorizedResponse};

/// Wrapper of `FallbackProvider` for use in `hyperlane-ethereum`
#[derive(new)]
pub struct EthereumFallbackProvider<C>(FallbackProvider<C>);

impl<C> Deref for EthereumFallbackProvider<C> {
    type Target = FallbackProvider<C>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<C> Debug for EthereumFallbackProvider<C>
where
    C: JsonRpcClient + PrometheusJsonRpcClientConfigExt,
{
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
impl<C> JsonRpcClient for EthereumFallbackProvider<C>
where
    C: JsonRpcClient<Error = HttpClientError>
        + PrometheusJsonRpcClientConfigExt
        + Into<Box<dyn BlockNumberGetter>>
        + Clone,
{
    type Error = ProviderError;

    // TODO: Refactor the reusable parts of this function when implementing the cosmos-specific logic
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
            let priorities_snapshot = self.take_priorities_snapshot().await;
            for (idx, priority) in priorities_snapshot.iter().enumerate() {
                let provider = &self.inner.providers[priority.index];
                let fut = match params {
                    Value::Null => provider.request(method, ()),
                    _ => provider.request(method, &params),
                };
                let resp = fut.await;
                self.handle_stalled_provider(priority, provider).await;
                let _span =
                    warn_span!("request_with_fallback", fallback_count=%idx, provider_index=%priority.index, ?provider).entered();

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

#[cfg(test)]
mod tests {
    use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, BLOCK_NUMBER_RPC};
    use hyperlane_core::rpc_clients::FallbackProviderBuilder;

    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    struct ProviderMock {
        // Store requests as tuples of (method, params)
        // Even if the tests were single-threaded, need the arc-mutex
        // for interior mutability in `JsonRpcClient::request`
        requests: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl ProviderMock {
        fn new() -> Self {
            Self {
                requests: Arc::new(Mutex::new(vec![])),
            }
        }

        fn push<T: Send + Sync + Serialize + Debug>(&self, method: &str, params: T) {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_owned(), format!("{:?}", params)));
        }

        fn requests(&self) -> Vec<(String, String)> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Into<Box<dyn BlockNumberGetter>> for ProviderMock {
        fn into(self) -> Box<dyn BlockNumberGetter> {
            Box::new(JsonRpcBlockGetter::new(self.clone()))
        }
    }

    fn dummy_return_value<R: DeserializeOwned>() -> Result<R, HttpClientError> {
        serde_json::from_str("0").map_err(|e| HttpClientError::SerdeJson {
            err: e,
            text: "".to_owned(),
        })
    }

    #[async_trait]
    impl JsonRpcClient for ProviderMock {
        type Error = HttpClientError;

        /// Pushes the `(method, params)` to the back of the `requests` queue,
        /// pops the responses from the back of the `responses` queue
        async fn request<T: Debug + Serialize + Send + Sync, R: DeserializeOwned>(
            &self,
            method: &str,
            params: T,
        ) -> Result<R, Self::Error> {
            self.push(method, params);
            sleep(Duration::from_millis(10)).await;
            dummy_return_value()
        }
    }

    impl PrometheusJsonRpcClientConfigExt for ProviderMock {
        fn node_host(&self) -> &str {
            todo!()
        }

        fn chain_name(&self) -> &str {
            todo!()
        }
    }

    async fn get_call_counts(fallback_provider: &FallbackProvider<ProviderMock>) -> Vec<usize> {
        fallback_provider
            .inner
            .priorities
            .read()
            .await
            .iter()
            .map(|p| {
                let provider = &fallback_provider.inner.providers[p.index];
                provider.requests().len()
            })
            .collect()
    }

    #[tokio::test]
    async fn test_first_provider_is_attempted() {
        let fallback_provider_builder = FallbackProviderBuilder::default();
        let providers = vec![
            ProviderMock::new(),
            ProviderMock::new(),
            ProviderMock::new(),
        ];
        let fallback_provider = fallback_provider_builder.add_providers(providers).build();
        let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
        ethereum_fallback_provider
            .request::<_, u64>(BLOCK_NUMBER_RPC, ())
            .await
            .unwrap();
        let provider_call_count: Vec<_> = get_call_counts(&ethereum_fallback_provider).await;
        assert_eq!(provider_call_count, vec![1, 0, 0]);
    }

    #[tokio::test]
    async fn test_one_stalled_provider() {
        let fallback_provider_builder = FallbackProviderBuilder::default();
        let providers = vec![
            ProviderMock::new(),
            ProviderMock::new(),
            ProviderMock::new(),
        ];
        let fallback_provider = fallback_provider_builder
            .add_providers(providers)
            .with_max_block_time(Duration::from_secs(0))
            .build();
        let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
        ethereum_fallback_provider
            .request::<_, u64>(BLOCK_NUMBER_RPC, ())
            .await
            .unwrap();

        let provider_call_count: Vec<_> = get_call_counts(&ethereum_fallback_provider).await;
        assert_eq!(provider_call_count, vec![0, 0, 2]);
    }

    // TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
    // two stalled providers (so that the for loop in `request` doesn't stop after the first provider)
}
