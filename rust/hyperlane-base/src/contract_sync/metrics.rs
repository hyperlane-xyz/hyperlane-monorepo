use crate::CoreMetrics;
use prometheus::{IntCounterVec, IntGaugeVec};

/// Struct encapsulating prometheus metrics used by the ContractSync.
#[derive(Debug, Clone)]
pub struct ContractSyncMetrics {
    /// Most recently indexed block height.
    ///
    /// Labels:
    /// - `data_type`: the data the indexer is recording. E.g. `messages` or `gas_payments`.
    /// - `chain`: Chain the indexer is collecting data from.
    pub indexed_height: IntGaugeVec,

    /// Events stored into HyperlaneDB (label values differentiate event types)
    ///
    /// Labels:
    /// - `data_type`: the data the indexer is recording. E.g. `messages` or `gas_payments`.
    /// - `chain`: Chain the indexer is collecting data from.
    pub stored_events: IntCounterVec,

    /// See `last_known_message_nonce` in CoreMetrics.
    pub message_nonce: IntGaugeVec,
}

impl ContractSyncMetrics {
    /// Instantiate a new ContractSyncMetrics object.
    pub fn new(metrics: &CoreMetrics) -> Self {
        let indexed_height = metrics
            .new_int_gauge(
                "contract_sync_block_height",
                "Height of a recently observed block",
                &["data_type", "chain"],
            )
            .expect("failed to register block_height metric");

        let stored_events = metrics
            .new_int_counter(
                "contract_sync_stored_events",
                "Number of events stored into db",
                &["data_type", "chain"],
            )
            .expect("failed to register stored_events metric");

        let message_nonce = metrics.last_known_message_nonce();

        ContractSyncMetrics {
            indexed_height,
            stored_events,
            message_nonce,
        }
    }
}
