// TODO: Re-enable clippy warnings
#![allow(dead_code)]

use std::time::UNIX_EPOCH;

use prometheus::{
    core::{AtomicU64, GenericGauge},
    labels, opts, register_int_counter_vec_with_registry, register_int_gauge_vec_with_registry,
    IntCounterVec, IntGaugeVec, Registry,
};

const METRICS_NAMESPACE: &str = "hyperlane_submitter";

/// Macro to prefix a string with the namespace.
fn namespaced(name: &str) -> String {
    format!("{}_{}", METRICS_NAMESPACE, name)
}

/// Metrics for a particular domain
#[derive(Clone)]
pub struct DispatcherMetrics {
    /// Metrics registry for adding new metrics and gathering reports
    registry: Registry,
    domain: String,

    // with a label for the stage, e.g. "building", "inclusion", "finality", "payload_db_loader", "tx_db_loader"
    pub task_liveness: IntGaugeVec,

    pub building_stage_queue_length: IntGaugeVec,
    pub inclusion_stage_pool_length: IntGaugeVec,
    pub finality_stage_pool_length: IntGaugeVec,

    pub dropped_payloads: IntCounterVec,
    pub dropped_transactions: IntCounterVec,

    pub finalized_transactions: IntCounterVec,

    // includes a label for the error causing the retry, and a label for the type of call
    pub call_retries: IntCounterVec,

    // total time spent submitting transactions
    pub in_flight_transaction_time: IntGaugeVec,
}

impl DispatcherMetrics {
    pub fn new(registry: Registry, domain: String) -> prometheus::Result<Self> {
        let stage_liveness = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("observed_validator_latest_index"),
                "The latest observed latest signed checkpoint indices per validator, from the perspective of the relayer",
            ),
            &[
                "destination",
                "stage",
            ],
            registry
        )?;

        let building_stage_queue_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("building_stage_queue_length"),
                "The number of payloads in the building stage queue",
            ),
            &["destination",],
            registry
        )?;
        let inclusion_stage_pool_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("inclusion_stage_pool_length"),
                "The number of payloads in the inclusion stage pool",
            ),
            &["destination",],
            registry
        )?;
        let finality_stage_pool_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("finality_stage_pool_length"),
                "The number of payloads in the finality stage pool",
            ),
            &["destination",],
            registry
        )?;
        let dropped_payloads = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("dropped_payloads"),
                "The number of payloads dropped",
            ),
            &["destination", "reason",],
            registry
        )?;
        let dropped_transactions = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("dropped_transactions"),
                "The number of transactions dropped",
            ),
            &["destination", "reason",],
            registry
        )?;
        let finalized_transactions = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("finalized_transactions"),
                "The number of transactions finalized",
            ),
            &["destination",],
            registry
        )?;
        let call_retries = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("call_retries"),
                "The number of times a call was retried",
            ),
            &["destination", "error_type", "call_type",],
            registry
        )?;
        let in_flight_transaction_time = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("in_flight_transaction_time"),
                "Total time spent in flight for transactions",
            ),
            &["destination",],
            registry
        )?;
        Ok(Self {
            task_liveness: stage_liveness,
            building_stage_queue_length,
            inclusion_stage_pool_length,
            finality_stage_pool_length,
            dropped_payloads,
            dropped_transactions,
            finalized_transactions,
            call_retries,
            in_flight_transaction_time,
            registry,
            domain,
        })
    }

    pub fn update_liveness_metric(&self, stage: &str) {
        self.task_liveness
            .with_label_values(&[&self.domain, stage])
            .set(
                UNIX_EPOCH
                    .elapsed()
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            );
    }

    #[cfg(test)]
    pub fn dummy_instance() -> Self {
        let registry = Registry::new();
        let domain = "test_domain".to_string();
        Self::new(registry, domain).unwrap()
    }
}
