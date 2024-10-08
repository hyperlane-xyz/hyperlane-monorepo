use eyre::Result;

use ethers_prometheus::middleware::*;

use crate::CoreMetrics;

pub(crate) fn create_provider_metrics(metrics: &CoreMetrics) -> Result<MiddlewareMetrics> {
    Ok(MiddlewareMetricsBuilder::default()
        .contract_call_duration_seconds(metrics.new_counter(
            "contract_call_duration_seconds",
            CONTRACT_CALL_DURATION_SECONDS_HELP,
            CONTRACT_CALL_DURATION_SECONDS_LABELS,
        )?)
        .contract_call_count(metrics.new_int_counter(
            "contract_call_count",
            CONTRACT_CALL_COUNT_HELP,
            CONTRACT_CALL_COUNT_LABELS,
        )?)
        .logs_query_duration_seconds(metrics.new_counter(
            "logs_query_duration_seconds",
            LOGS_QUERY_DURATION_SECONDS_HELP,
            LOGS_QUERY_DURATION_SECONDS_LABELS,
        )?)
        .logs_query_count(metrics.new_int_counter(
            "logs_query_count",
            LOG_QUERY_COUNT_HELP,
            LOGS_QUERY_COUNT_LABELS,
        )?)
        .transaction_send_duration_seconds(metrics.new_counter(
            "transaction_send_duration_seconds",
            TRANSACTION_SEND_DURATION_SECONDS_HELP,
            TRANSACTION_SEND_DURATION_SECONDS_LABELS,
        )?)
        .transaction_send_total(metrics.new_int_counter(
            "transaction_send_total",
            TRANSACTION_SEND_TOTAL_HELP,
            TRANSACTION_SEND_TOTAL_LABELS,
        )?)
        .build()?)
}
