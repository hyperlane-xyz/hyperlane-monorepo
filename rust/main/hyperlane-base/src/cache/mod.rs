mod error;
mod moka;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub use error::*;
pub use moka::*;

use hyperlane_core::H256;

/// Should be used as the `fn_params` when the function has no parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoParams;

/// Cache for storing function calls with serializable results
#[async_trait]
pub trait FunctionCallCache: Send + Sync {
    /// Set a value in the cache
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
