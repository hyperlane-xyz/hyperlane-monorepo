use std::fmt::Debug;

use async_trait::async_trait;
use derive_new::new;
use serde::{de::DeserializeOwned, Serialize};

use crate::cache::FunctionCallCache;

use super::CacheResult;

/// A Cache wrapper that instruments the cache calls with metrics.
#[derive(new, Debug, Clone)]
pub struct OptionalCache<C> {
    inner: Option<C>,
}

#[async_trait]
impl<C> FunctionCallCache for OptionalCache<C>
where
    C: FunctionCallCache,
{
    /// Calls the inner cache if it exists, otherwise returns Ok(())
    async fn cache_call_result(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<()> {
        if let Some(inner) = &self.inner {
            return inner
                .cache_call_result(domain_name, fn_key, fn_params, result)
                .await;
        }
        Ok(())
    }

    /// Calls the inner cache if it exists, otherwise returns Ok(None)
    async fn get_cached_call_result<T>(
        &self,
        domain_name: &str,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned,
    {
        if let Some(inner) = &self.inner {
            return inner
                .get_cached_call_result::<T>(domain_name, method, fn_params)
                .await;
        }
        Ok(None)
    }
}
