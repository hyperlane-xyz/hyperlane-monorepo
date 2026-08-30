use eyre::Result;

use crate::cache::*;

use super::CoreMetrics;

pub(crate) fn create_cache_metrics(metrics: &CoreMetrics) -> Result<MeteredCacheMetrics> {
    Ok(MeteredCacheMetricsBuilder::default()
        .hit_count(metrics.new_int_counter("hit_count", HIT_COUNT_HELP, HIT_COUNT_LABELS)?)
        .miss_count(metrics.new_int_counter("miss_count", MISS_COUNT_HELP, MISS_COUNT_LABELS)?)
        .entry_count(metrics.new_int_gauge("entry_count", ENTRY_COUNT_HELP, ENTRY_COUNT_LABELS)?)
        .weighted_size_bytes(metrics.new_int_gauge(
            "weighted_size_bytes",
            WEIGHTED_SIZE_BYTES_HELP,
            WEIGHTED_SIZE_BYTES_LABELS,
        )?)
        .eviction_count(metrics.new_int_counter(
            "eviction_count",
            EVICTION_COUNT_HELP,
            EVICTION_COUNT_LABELS,
        )?)
        .build()?)
}
