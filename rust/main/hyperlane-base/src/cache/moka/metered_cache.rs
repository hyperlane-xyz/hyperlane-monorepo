use std::fmt::Debug;

use async_trait::async_trait;
use derive_builder::Builder;
use derive_new::new;
use maplit::hashmap;
use prometheus::IntCounterVec;
use serde::{de::DeserializeOwned, Serialize};

use hyperlane_core::H256;

use crate::cache::HyperlaneCache;

use super::{CacheResult, Expiration};

/// Basic cache information.
#[derive(Debug, Clone)]
pub struct MeteredCacheConfig {
    /// The name of the cache set on creation.
    pub cache_name: &'static str,
}

/// Container for all the relevant cache metrics.
#[derive(Clone, Builder, Debug)]
pub struct MeteredCacheMetrics {
    /// The amount of calls which returned a cached result.
    /// - `cache_name`: the name of the cache.
    /// - `method`: the call stored in the cache.
    /// - `status`: the status of the call.
    #[builder(setter(into, strip_option), default)]
    pub hit_count: Option<IntCounterVec>,
    /// The amount of calls which did not return a cached result.
    /// - `cache_name`: the name of the cache.
    /// - `method`: the call stored in the cache.
    /// - `status`: the status of the call.
    #[builder(setter(into, strip_option), default)]
    pub miss_count: Option<IntCounterVec>,
}

/// Expected label names for the metric.
pub const HIT_COUNT_HELP: &str = "Number of cache hits";
/// Help string for the metric.
pub const HIT_COUNT_LABELS: &[&str] = &["cache_name", "method", "status"];

/// Expected label names for the metric.
pub const MISS_COUNT_HELP: &str = "Number of cache misses";
/// Help string for the metric.
pub const MISS_COUNT_LABELS: &[&str] = &["cache_name", "method", "status"];

/// A Cache wrapper that instruments the cache calls with metrics.
#[derive(new, Debug, Clone)]
pub struct MeteredCache<C> {
    inner: C,
    metrics: MeteredCacheMetrics,
    config: MeteredCacheConfig,
}

#[async_trait]
impl<C> HyperlaneCache for MeteredCache<C>
where
    C: HyperlaneCache,
{
    async fn cache_call_result(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Expiration> {
        self.inner
            .cache_call_result(contract_address, method, fn_params, result)
            .await
    }

    async fn get_cached_call_result<T>(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned,
    {
        let result = self
            .inner
            .get_cached_call_result::<T>(contract_address, method, fn_params)
            .await;

        let labels = hashmap! {
            "cache_name" => self.config.cache_name,
            "method" => method,
            "status" => if result.is_ok() { "success" } else { "failure" }
        };

        let is_hit = result.is_ok() && result.as_ref().unwrap().is_some();
        if is_hit {
            if let Some(hit_count) = &self.metrics.hit_count {
                hit_count.with(&labels).inc();
            }
        } else if let Some(miss_count) = &self.metrics.miss_count {
            miss_count.with(&labels).inc();
        }

        result
    }
}
