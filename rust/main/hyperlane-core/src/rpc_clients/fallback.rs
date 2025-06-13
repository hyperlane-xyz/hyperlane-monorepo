use async_rwlock::RwLock;
use async_trait::async_trait;
use derive_new::new;
use itertools::Itertools;
use std::{
    fmt::{Debug, Formatter},
    future::Future,
    marker::PhantomData,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio;
use tracing::{info, trace, warn_span};

use crate::ChainResult;

use super::RpcClientError;

/// Read the current block number from a chain.
#[async_trait]
pub trait BlockNumberGetter: Send + Sync + Debug {
    /// Latest block number getter
    async fn get_block_number(&self) -> ChainResult<u64>;
}

const MAX_BLOCK_TIME: Duration = Duration::from_secs(2);

/// Information about a provider in `PrioritizedProviders`

#[derive(Clone, Copy, new)]
pub struct PrioritizedProviderInner {
    /// Index into the `providers` field of `PrioritizedProviders`
    pub index: usize,
    /// Tuple of the block number and the time when it was queried
    #[new(value = "(0, Instant::now())")]
    last_block_height: (u64, Instant),
}

impl PrioritizedProviderInner {
    fn from_block_height(index: usize, block_height: u64) -> Self {
        Self {
            index,
            last_block_height: (block_height, Instant::now()),
        }
    }
}
/// Sub-providers and priority information
pub struct PrioritizedProviders<T> {
    /// Unsorted list of providers this provider calls
    pub providers: Vec<T>,
    /// Sorted list of providers this provider calls, in descending order or reliability
    pub priorities: RwLock<Vec<PrioritizedProviderInner>>,
}

/// A provider that bundles multiple providers and attempts to call the first,
/// then the second, and so on until a response is received.
///
/// Although no trait bounds are used in the struct definition, the intended purpose of `B`
/// is to be bound by `BlockNumberGetter` and have `T` be convertible to `B`. That is,
/// inner providers should be able to get the current block number, or be convertible into
/// something that is.
pub struct FallbackProvider<T, B> {
    /// The sub-providers called by this provider
    pub inner: Arc<PrioritizedProviders<T>>,
    max_block_time: Duration,
    _phantom: PhantomData<B>,
}

impl<T, B> FallbackProvider<T, B> {
    /// Get how many providers this fallback provider has
    pub fn len(&self) -> usize {
        self.inner.providers.len()
    }

    /// Check if this provider has any fallback providers
    pub fn is_empty(&self) -> bool {
        self.inner.providers.is_empty()
    }
}

impl<T, B> Clone for FallbackProvider<T, B> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            max_block_time: self.max_block_time,
            _phantom: PhantomData,
        }
    }
}

impl<T, B> Debug for FallbackProvider<T, B>
where
    T: Debug,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        // iterate the inner providers and write them to the formatter
        f.debug_struct("FallbackProvider")
            .field(
                "providers",
                &self
                    .inner
                    .providers
                    .iter()
                    .map(|v| format!("{:?}", v))
                    .join(", "),
            )
            .finish()
    }
}

impl<T, B> FallbackProvider<T, B>
where
    T: Into<B> + Debug + Clone,
    B: BlockNumberGetter,
{
    /// Convenience method for creating a `FallbackProviderBuilder` with same
    /// `JsonRpcClient` types
    pub fn builder() -> FallbackProviderBuilder<T, B> {
        FallbackProviderBuilder::default()
    }

    /// Create a new fallback provider
    pub fn new(providers: impl IntoIterator<Item = T>) -> Self {
        Self::builder().add_providers(providers).build()
    }

    async fn deprioritize_provider(&self, priority: PrioritizedProviderInner) {
        // De-prioritize the current provider by moving it to the end of the queue
        let mut priorities = self.inner.priorities.write().await;
        priorities.retain(|&p| p.index != priority.index);
        priorities.push(priority);
    }

    async fn update_last_seen_block(&self, provider_index: usize, current_block_height: u64) {
        let mut priorities = self.inner.priorities.write().await;
        // Get provider position in the up-to-date priorities vec
        if let Some(position) = priorities.iter().position(|p| p.index == provider_index) {
            priorities[position] =
                PrioritizedProviderInner::from_block_height(provider_index, current_block_height);
        }
    }

    /// Used to iterate the providers in a non-blocking way
    pub async fn take_priorities_snapshot(&self) -> Vec<PrioritizedProviderInner> {
        let read_lock = self.inner.priorities.read().await;
        (*read_lock).clone()
    }

    /// De-prioritize a provider that has either timed out or returned a bad response
    pub async fn handle_stalled_provider(&self, priority: &PrioritizedProviderInner, provider: &T) {
        let now = Instant::now();
        if now
            .duration_since(priority.last_block_height.1)
            .le(&self.max_block_time)
        {
            // Do nothing, it's too early to tell if the provider has stalled
            return;
        }

        let block_getter: B = provider.clone().into();
        let current_block_height = block_getter
            .get_block_number()
            .await
            .unwrap_or(priority.last_block_height.0);
        if current_block_height <= priority.last_block_height.0 {
            // The `max_block_time` elapsed but the block number returned by the provider has not increased
            self.deprioritize_provider(*priority).await;
            info!(
                provider_index=%priority.index,
                provider=?self.inner.providers[priority.index],
                "Deprioritizing an inner provider in FallbackProvider",
            );
        } else {
            self.update_last_seen_block(priority.index, current_block_height)
                .await;
        }
    }

    /// Call the first provider, then the second, and so on (in order of priority) until a response is received.
    /// If all providers fail, return an error.
    pub async fn call<V>(
        &self,
        mut f: impl FnMut(T) -> Pin<Box<dyn Future<Output = ChainResult<V>> + Send>>,
    ) -> ChainResult<V> {
        let mut errors = vec![];
        // make sure we do at least 4 total retries.
        while errors.len() <= 3 {
            if !errors.is_empty() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let priorities_snapshot = self.take_priorities_snapshot().await;
            for (idx, priority) in priorities_snapshot.iter().enumerate() {
                let provider = &self.inner.providers[priority.index];
                let resp = f(provider.clone()).await;
                self.handle_stalled_provider(priority, provider).await;
                let _span =
                    warn_span!("FallbackProvider::call", fallback_count=%idx, provider_index=%priority.index, ?provider).entered();
                match resp {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        trace!(
                            error=?e,
                            "Got error from inner fallback provider",
                        );
                        errors.push(e)
                    }
                }
            }
        }

        Err(RpcClientError::FallbackProvidersFailed(errors).into())
    }
}

/// Builder to create a new fallback provider.
#[derive(Debug, Clone)]
pub struct FallbackProviderBuilder<T, B> {
    providers: Vec<T>,
    max_block_time: Duration,
    _phantom: PhantomData<B>,
}

impl<T, B> Default for FallbackProviderBuilder<T, B> {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
            max_block_time: MAX_BLOCK_TIME,
            _phantom: PhantomData,
        }
    }
}

impl<T, B> FallbackProviderBuilder<T, B> {
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

    /// Only used for testing purposes.
    /// TODO: Move tests into this crate to control the visibility with conditional compilation.
    pub fn with_max_block_time(mut self, max_block_time: Duration) -> Self {
        self.max_block_time = max_block_time;
        self
    }

    /// Create a fallback provider.
    pub fn build(self) -> FallbackProvider<T, B> {
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
            _phantom: PhantomData,
        }
    }
}

/// Utilities to import when testing chain-specific fallback providers
pub mod test {
    use super::*;
    use std::{
        ops::Deref,
        sync::{Arc, Mutex},
    };

    /// Provider that stores requests and optionally sleeps before returning a dummy value
    #[derive(Debug, Clone)]
    pub struct ProviderMock {
        // Store requests as tuples of (method, params)
        // Even if the tests were single-threaded, need the arc-mutex
        // for interior mutability in `JsonRpcClient::request`
        requests: Arc<Mutex<Vec<(String, String)>>>,
        request_sleep: Option<Duration>,
    }

    impl Default for ProviderMock {
        fn default() -> Self {
            Self {
                requests: Arc::new(Mutex::new(vec![])),
                request_sleep: None,
            }
        }
    }

    impl ProviderMock {
        /// Create a new provider
        pub fn new(request_sleep: Option<Duration>) -> Self {
            Self {
                request_sleep,
                ..Default::default()
            }
        }

        /// Push a request to the internal store for later inspection
        pub fn push<T: Debug>(&self, method: &str, params: T) {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_owned(), format!("{:?}", params)));
        }

        /// Get the stored requests
        pub fn requests(&self) -> Vec<(String, String)> {
            self.requests.lock().unwrap().clone()
        }

        /// Set the sleep duration
        pub fn request_sleep(&self) -> Option<Duration> {
            self.request_sleep
        }

        /// Get how many times each provider was called
        pub async fn get_call_counts<T: Deref<Target = ProviderMock>, B>(
            fallback_provider: &FallbackProvider<T, B>,
        ) -> Vec<usize> {
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
    }
}
