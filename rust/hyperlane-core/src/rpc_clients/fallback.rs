use async_rwlock::RwLock;
use async_trait::async_trait;
use derive_new::new;
use std::{
    fmt::Debug,
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::info;

use crate::ChainCommunicationError;

/// Read the current block number from a chain.
#[async_trait]
pub trait BlockNumberGetter: Send + Sync + Debug {
    /// Latest block number getter
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError>;
}

const MAX_BLOCK_TIME: Duration = Duration::from_secs(2 * 60);

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
pub struct FallbackProvider<T> {
    /// The sub-providers called by this provider
    pub inner: Arc<PrioritizedProviders<T>>,
    max_block_time: Duration,
}

impl<T> Clone for FallbackProvider<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            max_block_time: self.max_block_time,
        }
    }
}

impl<T> FallbackProvider<T>
where
    T: Into<Box<dyn BlockNumberGetter>> + Debug + Clone,
{
    /// Convenience method for creating a `FallbackProviderBuilder` with same
    /// `JsonRpcClient` types
    pub fn builder() -> FallbackProviderBuilder<T> {
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

        let block_getter: Box<dyn BlockNumberGetter> = provider.clone().into();
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

    /// Only used for testing purposes.
    /// TODO: Move tests into this crate to control the visiblity with conditional compilation.
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
