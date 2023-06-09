use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use async_trait::async_trait;
use ethers::providers::{Http, JsonRpcClient, ProviderError};
use ethers_core::types::U64;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{instrument, warn_span};

use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClient;

use crate::rpc_clients::{categorize_client_response, CategorizedResponse};

const MAX_BLOCK_TIME: Duration = Duration::from_secs(2 * 60);
const BLOCK_NUMBER_RPC: &str = "eth_blockNumber";

type HttpFallbackProvider = FallbackProvider<PrometheusJsonRpcClient<Http>>;

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
pub struct FallbackProvider<T>(Arc<PrioritizedProviders<T>>);

impl<T> Clone for FallbackProvider<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl Debug for HttpFallbackProvider {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "FallbackProvider {{ chain_name: {}, hosts: [{}] }}",
            self.0
                .providers
                .get(0)
                .map(|v| v.chain_name())
                .unwrap_or("None"),
            self.0
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
        FallbackProvider(Arc::new(prioritized_providers))
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

async fn handle_stalled_provider(
    fallback_provider: &HttpFallbackProvider,
    priority: &PrioritizedProviderInner,
) -> Result<(), <HttpFallbackProvider as JsonRpcClient>::Error> {
    let now = Instant::now();
    if now
        .duration_since(priority.last_block_height.1)
        .le(&MAX_BLOCK_TIME)
    {
        // Do nothing, it's too early to tell if the provider has stalled
        return Ok(());
    }

    let provider = &fallback_provider.0.providers[priority.index];
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

async fn deprioritize_provider(
    fallback_provider: &HttpFallbackProvider,
    priority: &PrioritizedProviderInner,
) {
    // De-prioritize the current provider by moving it to the end of the queue
    let mut priorities = fallback_provider.0.priorities.write().await;
    priorities.retain(|&p| p.index != priority.index);
    priorities.push(*priority);
    // Free the write lock
}

async fn update_last_seen_block(
    fallback_provider: &HttpFallbackProvider,
    provider_index: usize,
    current_block_height: u64,
) {
    let mut priorities = fallback_provider.0.priorities.write().await;
    // Get provider position in the up-to-date priorities vec
    if let Some(position) = priorities.iter().position(|p| p.index == provider_index) {
        priorities[position] =
            PrioritizedProviderInner::from_block_height(provider_index, current_block_height);
    }
    // Free the write lock
}

async fn take_priorities_snapshot(
    fallback_provider: &HttpFallbackProvider,
) -> Vec<PrioritizedProviderInner> {
    let read_lock = fallback_provider.0.priorities.read().await;
    (*read_lock).clone()
    // Free the read lock
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl JsonRpcClient for HttpFallbackProvider {
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
                let provider = &self.0.providers[priority.index];
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

// #[cfg(test)]
// mod tests {
//     use super::*;
//     use ethers::providers::MockProvider;
//     use ethers_core::types::{U256, U64};

//     #[tokio::test]
//     async fn test_quorum() {
//         let fallback_provider_builder = FallbackProviderBuilder::default();

//         let num = 5u64;
//         let value = U256::from(42);
//         let mut providers = vec![
//             MockProvider::new(),
//             MockProvider::new(),
//             MockProvider::new(),
//         ];
//         fallback_provider_builder.add_providers(providers);
//         let provider = fallback_provider_builder.build();

//         // Mock responses (possibly by pushing valid items of one type that will fail to deserialize as T in `request::<T>()`)
//         // Ideally just mock error responses
//     }
// }
