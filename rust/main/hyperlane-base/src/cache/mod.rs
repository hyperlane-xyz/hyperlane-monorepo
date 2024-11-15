mod cache_types;
mod error;
mod moka;

pub use cache_types::*;
pub use error::*;
pub use moka::*;

use async_trait::async_trait;
use hyperlane_core::H256;
use serde::{de::DeserializeOwned, Serialize};

/// Hyperlane Cache Interface
#[async_trait]
pub trait HyperlaneCache: Send + Sync {
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
