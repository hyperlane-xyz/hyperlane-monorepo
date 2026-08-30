mod error;
mod metered_cache;
mod moka;
mod optional_cache;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub use error::CacheError;
pub use metered_cache::{
    MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, MeteredCacheMetricsBuilder,
    ENTRY_COUNT_HELP, ENTRY_COUNT_LABELS, EVICTION_COUNT_HELP, EVICTION_COUNT_LABELS,
    HIT_COUNT_HELP, HIT_COUNT_LABELS, MISS_COUNT_HELP, MISS_COUNT_LABELS, WEIGHTED_SIZE_BYTES_HELP,
    WEIGHTED_SIZE_BYTES_LABELS,
};
pub use moka::{CacheResult, Expiration, ExpirationType, LocalCache};
pub use optional_cache::OptionalCache;

/// Cache statistics consumed by [`MeteredCache`].
#[derive(Debug, Default, Eq, PartialEq)]
pub struct CacheMetricsSnapshot {
    /// Approximate number of entries currently in the cache, when supported.
    pub entry_count: Option<u64>,
    /// Approximate weighted size currently in the cache, when supported.
    pub weighted_size: Option<u64>,
    /// Entries evicted due to expiration since the last metrics update.
    pub expired_evictions: u64,
    /// Entries evicted due to capacity since the last metrics update.
    pub size_evictions: u64,
}

/// Should be used as the `fn_params` when the function has no parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoParams;

/// Cache for storing function calls with serializable results
#[async_trait]
pub trait FunctionCallCache: Send + Sync {
    /// Return cache statistics when supported by the implementation.
    fn metrics_snapshot(&self) -> CacheMetricsSnapshot {
        CacheMetricsSnapshot::default()
    }

    /// Cache a call result with the given parameters
    async fn cache_call_result(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<()>;

    /// Cache a call result with the given parameters and expiration.
    async fn cache_call_result_with_expiration(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
        expiration: ExpirationType,
    ) -> CacheResult<()>;

    /// Get a cached call result with the given parameters
    async fn get_cached_call_result<T>(
        &self,
        domain_name: &str,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned;
}
