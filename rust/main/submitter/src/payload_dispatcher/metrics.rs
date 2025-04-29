// TODO: Re-enable clippy warnings
#![allow(dead_code)]

use std::time::UNIX_EPOCH;

use prometheus::{
    core::{AtomicU64, GenericGauge},
    labels, opts, register_int_counter_vec_with_registry, register_int_gauge_vec_with_registry,
    Encoder, IntCounterVec, IntGaugeVec, Registry,
};
use tracing::{debug, info, warn};

const METRICS_NAMESPACE: &str = "hyperlane_lander";

/// Macro to prefix a string with the namespace.
fn namespaced(name: &str) -> String {
    format!("{}_{}", METRICS_NAMESPACE, name)
}

/// Metrics for a particular domain
#[derive(Clone)]
pub struct DispatcherMetrics {
    /// Metrics registry for adding new metrics and gathering reports
    registry: Registry,
    // with a label for the stage, e.g. "building", "inclusion", "finality", "payload_db_loader", "tx_db_loader"
    pub task_liveness: IntGaugeVec,

    pub building_stage_queue_length: IntGaugeVec,
    pub inclusion_stage_pool_length: IntGaugeVec,
    pub finality_stage_pool_length: IntGaugeVec,

    pub dropped_payloads: IntCounterVec,
    pub dropped_transactions: IntCounterVec,

    pub transaction_resubmissions: IntCounterVec,

    pub finalized_transactions: IntCounterVec,

    // includes a label for the error causing the retry, and a label for the type of call
    pub call_retries: IntCounterVec,

    // total time spent submitting transactions
    pub in_flight_transaction_time: IntGaugeVec,
}

impl DispatcherMetrics {
    pub fn new(registry: Registry) -> eyre::Result<Self> {
        let task_liveness = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("task_liveness"),
                "The liveness of the dispatcher tasks, expressed as a timestamp since the epoch",
            ),
            &["destination", "stage",],
            registry.clone()
        )?;
        let building_stage_queue_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("building_stage_queue_length"),
                "The number of payloads in the building stage queue",
            ),
            &["destination",],
            registry.clone()
        )?;
        let inclusion_stage_pool_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("inclusion_stage_pool_length"),
                "The number of transactions in the inclusion stage pool",
            ),
            &["destination",],
            registry.clone()
        )?;
        let finality_stage_pool_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("finality_stage_pool_length"),
                "The number of transactions in the finality stage pool",
            ),
            &["destination",],
            registry.clone()
        )?;
        let dropped_payloads = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("dropped_payloads"),
                "The number of payloads dropped",
            ),
            &["destination", "reason",],
            registry.clone()
        )?;
        let dropped_transactions = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("dropped_transactions"),
                "The number of transactions dropped",
            ),
            &["destination", "reason",],
            registry.clone()
        )?;
        let transaction_resubmissions = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("transaction_resubmissions"),
                "The number of times transactions were resubmitted",
            ),
            &["destination",],
            registry.clone()
        )?;
        let finalized_transactions = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("finalized_transactions"),
                "The number of transactions finalized",
            ),
            &["destination",],
            registry.clone()
        )?;
        let call_retries = register_int_counter_vec_with_registry!(
            opts!(
                namespaced("call_retries"),
                "The number of times a call was retried",
            ),
            &["destination", "error_type", "call_type",],
            registry.clone()
        )?;
        let in_flight_transaction_time = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("in_flight_transaction_time"),
                "Total time spent in flight for transactions",
            ),
            &["destination",],
            registry.clone()
        )?;
        Ok(Self {
            registry: registry.clone(),
            task_liveness,
            building_stage_queue_length,
            inclusion_stage_pool_length,
            finality_stage_pool_length,
            dropped_payloads,
            dropped_transactions,
            transaction_resubmissions,
            finalized_transactions,
            call_retries,
            in_flight_transaction_time,
        })
    }

    pub fn update_liveness_metric(&self, stage: &str, domain: &str) {
        self.task_liveness.with_label_values(&[domain, stage]).set(
            UNIX_EPOCH
                .elapsed()
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        );
    }

    pub fn update_queue_length_metric(&self, stage: &str, length: u64, domain: &str) {
        match stage {
            crate::payload_dispatcher::building_stage::STAGE_NAME => self
                .building_stage_queue_length
                .with_label_values(&[domain])
                .set(length as i64),
            crate::payload_dispatcher::inclusion_stage::STAGE_NAME => self
                .inclusion_stage_pool_length
                .with_label_values(&[domain])
                .set(length as i64),
            crate::payload_dispatcher::finality_stage::STAGE_NAME => self
                .finality_stage_pool_length
                .with_label_values(&[domain])
                .set(length as i64),
            _ => {}
        }
    }

    pub fn update_dropped_payloads_metric(&self, reason: &str, domain: &str) {
        self.dropped_payloads
            .with_label_values(&[domain, reason])
            .inc();
    }

    pub fn update_dropped_transactions_metric(&self, reason: &str, domain: &str) {
        self.dropped_transactions
            .with_label_values(&[domain, reason])
            .inc();
    }

    pub fn update_transaction_resubmissions_metric(&self, domain: &str) {
        self.transaction_resubmissions
            .with_label_values(&[domain])
            .inc();
    }

    pub fn update_finalized_transactions_metric(&self, domain: &str) {
        self.finalized_transactions
            .with_label_values(&[domain])
            .inc();
    }

    pub fn update_call_retries_metric(&self, error_type: &str, call_type: &str, domain: &str) {
        self.call_retries
            .with_label_values(&[domain, error_type, call_type])
            .inc();
    }

    pub fn gather(&self) -> prometheus::Result<Vec<u8>> {
        let collected_metrics = self.registry.gather();
        let mut out_buf = Vec::with_capacity(1024 * 64);
        let encoder = prometheus::TextEncoder::new();
        encoder.encode(&collected_metrics, &mut out_buf)?;
        Ok(out_buf)
    }

    #[cfg(test)]
    pub fn dummy_instance() -> Self {
        let registry = Registry::new();
        let instance = Self::new(registry.clone());
        instance.unwrap()
    }
}
