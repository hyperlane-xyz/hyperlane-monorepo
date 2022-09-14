use eyre::Result;

use ethers_prometheus::middleware::*;

use crate::{CoreMetrics, NETWORK_HISTOGRAM_BUCKETS};

pub(crate) fn create_provider_metrics(metrics: &CoreMetrics) -> Result<MiddlewareMetrics> {
    Ok(MiddlewareMetricsBuilder::default()
        .block_height(metrics.new_int_gauge(
            "block_height",
            BLOCK_HEIGHT_HELP,
            BLOCK_HEIGHT_LABELS,
        )?)
        .gas_price_gwei(metrics.new_gauge(
            "gas_price_gwei",
            GAS_PRICE_GWEI_HELP,
            GAS_PRICE_GWEI_LABELS,
        )?)
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
        .transaction_send_duration_seconds(metrics.new_histogram(
            "transaction_send_duration_seconds",
            TRANSACTION_SEND_DURATION_SECONDS_HELP,
            TRANSACTION_SEND_DURATION_SECONDS_LABELS,
            NETWORK_HISTOGRAM_BUCKETS.into(),
        )?)
        .transaction_send_total(metrics.new_int_counter(
            "transaction_send_total",
            TRANSACTION_SEND_TOTAL_HELP,
            TRANSACTION_SEND_TOTAL_LABELS,
        )?)
        .wallet_balance(metrics.new_gauge(
            "wallet_balance",
            WALLET_BALANCE_HELP,
            WALLET_BALANCE_LABELS,
        )?)
        .build()?)
}
