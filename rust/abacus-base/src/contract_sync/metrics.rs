use crate::CoreMetrics;
use prometheus::{IntCounterVec, IntGauge, IntGaugeVec};
use std::sync::Arc;

/// Struct encapsulating prometheus metrics used by the ContractSync.
#[derive(Debug, Clone)]
pub struct ContractSyncMetrics {
    /// Most recently indexed block height (label values differentiate checkpoints
    /// vs. messages)
    pub indexed_height: IntGaugeVec,
    /// Events stored into DB (label values differentiate checkpoints vs. messages)
    pub stored_events: IntGaugeVec,
    /// Unique occasions when agent missed an event (label values
    /// differentiate checkpoints vs. messages)
    pub missed_events: IntCounterVec,
    /// An optional gauge for tracking the latest message leafs that are being indexed
    pub message_leaf_index: Option<IntGauge>,
}

impl ContractSyncMetrics {
    /// Instantiate a new ContractSyncMetrics object.
    pub fn new(metrics: Arc<CoreMetrics>, opt_labels: Option<&[&str]>) -> Self {
        let indexed_height = metrics
            .new_int_gauge(
                "contract_sync_block_height",
                "Height of a recently observed block",
                &["data_type", "contract_name", "agent"],
            )
            .expect("failed to register block_height metric");

        let stored_events = metrics
            .new_int_gauge(
                "contract_sync_stored_events",
                "Number of events stored into db",
                &["data_type", "contract_name", "agent"],
            )
            .expect("failed to register stored_events metric");

        let missed_events = metrics
            .new_int_counter(
                "contract_sync_missed_events",
                "Number of unique occasions when agent missed an event",
                &["data_type", "contract_name", "agent"],
            )
            .expect("failed to register missed_events metric");

        let message_leaf_index = opt_labels.map(|labels| {
            metrics
                .last_known_message_leaf_index()
                .with_label_values(labels)
        });
        ContractSyncMetrics {
            indexed_height,
            stored_events,
            missed_events,
            message_leaf_index,
        }
    }
}
