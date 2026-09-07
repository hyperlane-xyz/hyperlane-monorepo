use std::fmt::Debug;

use async_trait::async_trait;
use derive_builder::Builder;
use derive_new::new;
use maplit::hashmap;
use prometheus::{IntCounterVec, IntGaugeVec};
use serde::{de::DeserializeOwned, Serialize};

use crate::cache::FunctionCallCache;

use super::{CacheResult, ExpirationType};

/// Basic cache information.
#[derive(Debug, Clone)]
pub struct MeteredCacheConfig {
    /// The name of the cache set on creation.
    pub cache_name: String,
}

/// Container for all the relevant cache metrics.
#[derive(Clone, Builder, Debug)]
pub struct MeteredCacheMetrics {
    /// The amount of calls which returned a cached result.
    /// - `cache_name`: the name of the cache.
    /// - `chain`: the name of the chain.
    /// - `method`: the call stored in the cache.
    /// - `status`: the status of the call.
    #[builder(setter(into, strip_option), default)]
    pub hit_count: Option<IntCounterVec>,
    /// The amount of calls which did not return a cached result.
    /// - `cache_name`: the name of the cache.
    /// - `chain`: the name of the chain.
    /// - `method`: the call stored in the cache.
    /// - `status`: the status of the call.
    #[builder(setter(into, strip_option), default)]
    pub miss_count: Option<IntCounterVec>,
    /// Approximate number of entries currently in the cache.
    /// - `cache_name`: the name of the cache.
    #[builder(setter(into, strip_option), default)]
    pub entry_count: Option<IntGaugeVec>,
    /// Approximate serialized key and value bytes currently in the cache.
    /// - `cache_name`: the name of the cache.
    #[builder(setter(into, strip_option), default)]
    pub weighted_size_bytes: Option<IntGaugeVec>,
    /// Number of entries evicted from the cache.
    /// - `cache_name`: the name of the cache.
    /// - `cause`: the eviction cause (`expired` or `size`).
    #[builder(setter(into, strip_option), default)]
    pub eviction_count: Option<IntCounterVec>,
}

/// Expected label names for the metric.
pub const HIT_COUNT_HELP: &str = "Number of cache hits";
/// Help string for the metric.
pub const HIT_COUNT_LABELS: &[&str] = &["cache_name", "chain", "method", "status"];

/// Expected label names for the metric.
pub const MISS_COUNT_HELP: &str = "Number of cache misses";
/// Help string for the metric.
pub const MISS_COUNT_LABELS: &[&str] = &["cache_name", "chain", "method", "status"];

/// Help string for the cache entry count metric.
pub const ENTRY_COUNT_HELP: &str = "Approximate number of entries in the cache";
/// Expected label names for the metric.
pub const ENTRY_COUNT_LABELS: &[&str] = &["cache_name"];

/// Help string for the weighted cache size metric.
pub const WEIGHTED_SIZE_BYTES_HELP: &str =
    "Approximate serialized key and value bytes in the cache";
/// Expected label names for the metric.
pub const WEIGHTED_SIZE_BYTES_LABELS: &[&str] = &["cache_name"];

/// Help string for the cache eviction count metric.
pub const EVICTION_COUNT_HELP: &str = "Number of entries evicted from the cache";
/// Expected label names for the metric.
pub const EVICTION_COUNT_LABELS: &[&str] = &["cache_name", "cause"];

/// A Cache wrapper that instruments the cache calls with metrics.
#[derive(new, Debug, Clone)]
pub struct MeteredCache<C> {
    inner: C,
    metrics: MeteredCacheMetrics,
    config: MeteredCacheConfig,
}

impl<C> MeteredCache<C>
where
    C: FunctionCallCache,
{
    fn update_cache_metrics(&self) {
        let cache_name = self.config.cache_name.as_str();
        let snapshot = self.inner.metrics_snapshot();

        if let (Some(entry_count), Some(value)) = (&self.metrics.entry_count, snapshot.entry_count)
        {
            entry_count
                .with_label_values(&[cache_name])
                .set(i64::try_from(value).unwrap_or(i64::MAX));
        }
        if let (Some(weighted_size_bytes), Some(value)) =
            (&self.metrics.weighted_size_bytes, snapshot.weighted_size)
        {
            weighted_size_bytes
                .with_label_values(&[cache_name])
                .set(i64::try_from(value).unwrap_or(i64::MAX));
        }
        if let Some(eviction_count) = &self.metrics.eviction_count {
            eviction_count
                .with_label_values(&[cache_name, "expired"])
                .inc_by(snapshot.expired_evictions);
            eviction_count
                .with_label_values(&[cache_name, "size"])
                .inc_by(snapshot.size_evictions);
        }
    }
}

#[async_trait]
impl<C> FunctionCallCache for MeteredCache<C>
where
    C: FunctionCallCache,
{
    async fn cache_call_result(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<()> {
        let result = self
            .inner
            .cache_call_result(domain_name, fn_key, fn_params, result)
            .await;
        self.update_cache_metrics();
        result
    }

    async fn cache_call_result_with_expiration(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
        expiration: ExpirationType,
    ) -> CacheResult<()> {
        let result = self
            .inner
            .cache_call_result_with_expiration(domain_name, fn_key, fn_params, result, expiration)
            .await;
        self.update_cache_metrics();
        result
    }

    async fn get_cached_call_result<T>(
        &self,
        domain_name: &str,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned,
    {
        let result = self
            .inner
            .get_cached_call_result::<T>(domain_name, method, fn_params)
            .await;

        let labels = hashmap! {
            "cache_name" => self.config.cache_name.as_str(),
            "chain" => domain_name,
            "method" => method,
            "status" => if result.is_ok() { "success" } else { "failure" }
        };

        let is_hit = result.as_ref().map(|r| r.is_some()).unwrap_or(false);
        if is_hit {
            if let Some(hit_count) = &self.metrics.hit_count {
                hit_count.with(&labels).inc();
            }
        } else if let Some(miss_count) = &self.metrics.miss_count {
            miss_count.with(&labels).inc();
        }

        self.update_cache_metrics();

        result
    }
}
