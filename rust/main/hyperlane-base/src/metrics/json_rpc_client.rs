use eyre::Result;
use hyperlane_metric::prometheus_metric::{
    PrometheusClientMetrics, PrometheusClientMetricsBuilder, PROVIDER_CREATE_COUNT_HELP,
    PROVIDER_CREATE_COUNT_LABELS, PROVIDER_DROP_COUNT_HELP, PROVIDER_DROP_COUNT_LABELS,
    REQUEST_COUNT_HELP, REQUEST_COUNT_LABELS, REQUEST_DURATION_SECONDS_HELP,
    REQUEST_DURATION_SECONDS_LABELS,
};

use crate::CoreMetrics;

pub(crate) fn create_json_rpc_client_metrics(
    metrics: &CoreMetrics,
) -> Result<PrometheusClientMetrics> {
    Ok(PrometheusClientMetricsBuilder::default()
        .request_count(metrics.new_int_counter(
            "request_count",
            REQUEST_COUNT_HELP,
            REQUEST_COUNT_LABELS,
        )?)
        .request_duration_seconds(metrics.new_counter(
            "request_duration_seconds",
            REQUEST_DURATION_SECONDS_HELP,
            REQUEST_DURATION_SECONDS_LABELS,
        )?)
        .provider_create_count(metrics.new_int_counter(
            "provider_create_count",
            PROVIDER_CREATE_COUNT_HELP,
            PROVIDER_CREATE_COUNT_LABELS,
        )?)
        .provider_drop_count(metrics.new_int_counter(
            "provider_drop_count",
            PROVIDER_DROP_COUNT_HELP,
            PROVIDER_DROP_COUNT_LABELS,
        )?)
        .build()?)
}
