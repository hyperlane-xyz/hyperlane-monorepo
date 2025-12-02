use std::fmt::Debug;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};

use crate::cache::FunctionCallCache;

use super::{BaseCache, CacheResult, ExpirationType};

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
        domain_name: &str,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<()> {
        let key = (domain_name, method, fn_params);
        self.0
            .set(&key, result, ExpirationType::Default)
            .await
            .map(|_| ())
    }

    /// Get a cached call result with the given parameters
    async fn get_cached_call_result<T>(
        &self,
        domain_name: &str,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned,
    {
        let key = (domain_name, method, fn_params);
        let value = self.0.get::<T>(&key).await?;

        match value {
            Some((value, _)) => Ok(Some(value)),
            None => Ok(None),
        }
    }
}
