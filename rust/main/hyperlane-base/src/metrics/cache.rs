use eyre::Result;

use crate::cache::*;

use super::CoreMetrics;

pub(crate) fn create_cache_metrics(metrics: &CoreMetrics) -> Result<MeteredCacheMetrics> {
    Ok(MeteredCacheMetricsBuilder::default()
        .hit_count(metrics.new_int_counter("hit_count", HIT_COUNT_HELP, HIT_COUNT_LABELS)?)
        .miss_count(metrics.new_int_counter("miss_count", MISS_COUNT_HELP, MISS_COUNT_LABELS)?)
        .build()?)
}
