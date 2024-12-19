use std::fmt::Debug;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};

use hyperlane_core::H256;

use crate::cache::FunctionCallCache;

use super::{BaseCache, CacheResult, Expiration, ExpirationType};

/// Local cache for storing function calls with serializable results in memory
#[derive(Debug, Clone)]
pub struct LocalCache(BaseCache);

impl LocalCache {
    /// Create a new local cache with the given name
    pub fn new(name: &str) -> Self {
        Self(BaseCache::new(name))
    }
}

#[async_trait]
impl FunctionCallCache for LocalCache {
    /// Cache a call result with the given parameters
    async fn cache_call_result(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Expiration> {
        let key = (contract_address, method, fn_params);
        self.0.set(&key, result, ExpirationType::Default).await
    }

    /// Get a cached call result with the given parameters
    async fn get_cached_call_result<T>(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned,
    {
        let key = (contract_address, method, fn_params);
        let value = self.0.get::<T>(&key).await?;

        match value {
            Some((value, _)) => Ok(Some(value)),
            None => Ok(None),
        }
    }
}
