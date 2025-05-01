mod error;
mod metered_cache;
mod moka;
mod optional_cache;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub use error::CacheError;
pub use metered_cache::{
    MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, MeteredCacheMetricsBuilder,
    HIT_COUNT_HELP, HIT_COUNT_LABELS, MISS_COUNT_HELP, MISS_COUNT_LABELS,
};
pub use moka::{CacheResult, Expiration, LocalCache};
pub use optional_cache::OptionalCache;

/// Should be used as the `fn_params` when the function has no parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoParams;

/// Cache for storing function calls with serializable results
#[async_trait]
pub trait FunctionCallCache: Send + Sync {
    /// Cache a call result with the given parameters
    async fn cache_call_result(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
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
