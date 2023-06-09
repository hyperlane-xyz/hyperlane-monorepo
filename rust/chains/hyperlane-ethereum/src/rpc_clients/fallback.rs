use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use async_trait::async_trait;
use ethers::providers::{Http, HttpClientError, JsonRpcClient, ProviderError};
use ethers_core::types::U64;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{instrument, warn_span};

use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClientConfigExt;

use crate::rpc_clients::{categorize_client_response, CategorizedResponse};

const MAX_BLOCK_TIME: Duration = Duration::from_secs(2 * 60);
const BLOCK_NUMBER_RPC: &str = "eth_blockNumber";

#[derive(Clone, Copy)]
struct PrioritizedProviderInner {
    // Index into the `providers` field of `PrioritizedProviders`
    index: usize,
    // Tuple of the block number and the time when it was queried
    last_block_height: (u64, Instant),
}

impl PrioritizedProviderInner {
    fn new(index: usize) -> Self {
        Self {
            index,
            last_block_height: (0, Instant::now()),
        }
    }

    fn from_block_height(index: usize, block_height: u64) -> Self {
        Self {
            index,
            last_block_height: (block_height, Instant::now()),
        }
    }
}

struct PrioritizedProviders<T> {
    /// Sorted list of providers this provider calls in order of most primary to
    /// most fallback.
    providers: Vec<T>,
    priorities: RwLock<Vec<PrioritizedProviderInner>>,
}

/// A provider that bundles multiple providers and attempts to call the first,
/// then the second, and so on until a response is received.
pub struct FallbackProvider<T> {
    inner: Arc<PrioritizedProviders<T>>,
    max_block_time: Duration,
}

impl<T> Clone for FallbackProvider<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            max_block_time: self.max_block_time.clone(),
        }
    }
}

impl<C> Debug for FallbackProvider<C>
where
    C: JsonRpcClient + PrometheusJsonRpcClientConfigExt,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "FallbackProvider {{ chain_name: {}, hosts: [{}] }}",
            self.inner
                .providers
                .get(0)
                .map(|v| v.chain_name())
                .unwrap_or("None"),
            self.inner
                .providers
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
    max_block_time: Duration,
}

impl<T> Default for FallbackProviderBuilder<T> {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
            max_block_time: MAX_BLOCK_TIME,
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

    pub fn with_max_block_time(mut self, max_block_time: Duration) -> Self {
        self.max_block_time = max_block_time;
        self
    }

    /// Create a fallback provider.
    pub fn build(self) -> FallbackProvider<T> {
        let provider_count = self.providers.len();
        let prioritized_providers = PrioritizedProviders {
            providers: self.providers,
            // The order of `self.providers` gives the initial priority.
            priorities: RwLock::new(
                (0..provider_count)
                    .map(PrioritizedProviderInner::new)
                    .collect(),
            ),
        };
        FallbackProvider {
            inner: Arc::new(prioritized_providers),
            max_block_time: self.max_block_time,
        }
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

async fn handle_stalled_provider<C>(
    fallback_provider: &FallbackProvider<C>,
    priority: &PrioritizedProviderInner,
) -> Result<(), ProviderError>
where
    C: JsonRpcClient,
{
    let now = Instant::now();
    if now
        .duration_since(priority.last_block_height.1)
        .le(&fallback_provider.max_block_time)
    {
        // Do nothing, it's too early to tell if the provider has stalled
        return Ok(());
    }

    let provider = &fallback_provider.inner.providers[priority.index];
    let current_block_height: u64 = provider
        .request(BLOCK_NUMBER_RPC, ())
        .await
        .map(|r: U64| r.as_u64())
        .unwrap_or(priority.last_block_height.0);
    if current_block_height > priority.last_block_height.0 {
        deprioritize_provider(fallback_provider, priority).await;
    } else {
        update_last_seen_block(fallback_provider, priority.index, current_block_height).await
    }
    Ok(())
}

async fn deprioritize_provider<C>(
    fallback_provider: &FallbackProvider<C>,
    priority: &PrioritizedProviderInner,
) where
    C: JsonRpcClient,
{
    // De-prioritize the current provider by moving it to the end of the queue
    let mut priorities = fallback_provider.inner.priorities.write().await;
    priorities.retain(|&p| p.index != priority.index);
    priorities.push(*priority);
    // Free the write lock
}

async fn update_last_seen_block<C>(
    fallback_provider: &FallbackProvider<C>,
    provider_index: usize,
    current_block_height: u64,
) where
    C: JsonRpcClient,
{
    let mut priorities = fallback_provider.inner.priorities.write().await;
    // Get provider position in the up-to-date priorities vec
    if let Some(position) = priorities.iter().position(|p| p.index == provider_index) {
        priorities[position] =
            PrioritizedProviderInner::from_block_height(provider_index, current_block_height);
    }
    // Free the write lock
}

async fn take_priorities_snapshot<C>(
    fallback_provider: &FallbackProvider<C>,
) -> Vec<PrioritizedProviderInner>
where
    C: JsonRpcClient,
{
    let read_lock = fallback_provider.inner.priorities.read().await;
    (*read_lock).clone()
    // Free the read lock
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl<C> JsonRpcClient for FallbackProvider<C>
where
    C: JsonRpcClient<Error = HttpClientError> + PrometheusJsonRpcClientConfigExt,
{
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
            let priorities_snapshot = take_priorities_snapshot(self).await;
            for (idx, priority) in priorities_snapshot.iter().enumerate() {
                let provider = &self.inner.providers[priority.index];
                let fut = match params {
                    Value::Null => provider.request(method, ()),
                    _ => provider.request(method, &params),
                };
                let resp = fut.await;
                handle_stalled_provider(self, priority).await?;

                match categorize_client_response(method, resp) {
                    IsOk(v) => {
                        let _span =
                            warn_span!("request_with_fallback", provider_index=%idx, ?provider)
                                .entered();
                        return Ok(serde_json::from_value(v)?);
                    }
                    RetryableErr(e) | RateLimitErr(e) => {
                        deprioritize_provider(self, priority).await;
                        let _span =
                            warn_span!("request_with_fallback", provider_index=%idx, ?provider)
                                .entered();
                        errors.push(e.into())
                    }
                    NonRetryableErr(e) => {
                        let _span =
                            warn_span!("request_with_fallback", provider_index=%idx, ?provider)
                                .entered();
                        return Err(e.into());
                    }
                }
            }
        }

        Err(FallbackError::AllProvidersFailed(errors).into())
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Borrow;

    use super::*;
    use ethers::providers::{MockError, MockProvider};

    use ethers_core::types::{U256, U64};
    use reqwest::Error as ReqwestError;

    #[derive(Debug)]
    // TODO: store requests to avoid depending on MockProvider
    struct ProviderMock(MockProvider);
    impl ProviderMock {
        fn new() -> Self {
            Self(MockProvider::new())
        }

        fn push<T: Serialize + Send + Sync, K: Borrow<T>>(&self, data: K) -> Result<(), MockError> {
            self.0.push(data)
        }
    }

    #[async_trait]
    impl JsonRpcClient for ProviderMock {
        type Error = HttpClientError;

        /// Pushes the `(method, params)` to the back of the `requests` queue,
        /// pops the responses from the back of the `responses` queue
        async fn request<T: Serialize + Send + Sync + Debug, R: DeserializeOwned>(
            &self,
            method: &str,
            params: T,
        ) -> Result<R, Self::Error> {
            sleep(Duration::from_millis(10)).await;
            serde_json::from_str("0").map_err(|e| HttpClientError::SerdeJson {
                err: e,
                text: "".to_owned(),
            })
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

    #[tokio::test]
    async fn test_one_stalled_provider() {
        let fallback_provider_builder = FallbackProviderBuilder::default();

        let num = 5u64;
        let value = U256::from(42);
        let mut providers = vec![
            ProviderMock::new(),
            ProviderMock::new(),
            ProviderMock::new(),
        ];
        // providers[0].assert_request(method, data)
        providers[0].push(U64::from(0)).unwrap();
        // providers[0].push(128).unwrap();
        let fallback_provider = fallback_provider_builder
            .add_providers(providers)
            .with_max_block_time(Duration::from_secs(0))
            .build();
        let x: u64 = fallback_provider
            .request(BLOCK_NUMBER_RPC, ())
            .await
            .unwrap();
        println!("{}", x);

        // Set the MAX_BLOCK_TIME to zero
        // sleep for 0.01s
        // mock response to be block no zero
        // call anything, expect provider to be deprioritized
        // check that by only expecting `assert_request` to succeed
        // on the last provider
    }
}
