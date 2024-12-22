mod error;
mod metered_cache;
mod moka;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub use error::CacheError;
pub use metered_cache::{
    MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, MeteredCacheMetricsBuilder,
    HIT_COUNT_HELP, HIT_COUNT_LABELS, MISS_COUNT_HELP, MISS_COUNT_LABELS,
};
pub use moka::{CacheResult, Expiration, LocalCache};

use hyperlane_core::H256;

/// Should be used as the `fn_params` when the function has no parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoParams;

/// Cache for storing function calls with serializable results
#[async_trait]
pub trait FunctionCallCache: Send + Sync {
    /// Cache a call result with the given parameters
    async fn cache_call_result(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Expiration>;

    /// Get a cached call result with the given parameters
    async fn get_cached_call_result<T>(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned;
}
