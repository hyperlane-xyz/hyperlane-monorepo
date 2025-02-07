use ethers_prometheus::json_rpc_client::*;
use eyre::Result;

use crate::CoreMetrics;

pub(crate) fn create_json_rpc_client_metrics(
    metrics: &CoreMetrics,
) -> Result<JsonRpcClientMetrics> {
    Ok(JsonRpcClientMetricsBuilder::default()
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
        .build()?)
}
