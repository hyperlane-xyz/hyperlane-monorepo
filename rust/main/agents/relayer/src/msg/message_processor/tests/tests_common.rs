// Common test utilities for message processor tests

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mockall::mock;
use prometheus::{IntGauge, IntGaugeVec};
use serde::Serialize;
use tokio::sync::broadcast;

// Re-export for use in other test modules
pub use hyperlane_base::tests::mock_hyperlane_db::MockHyperlaneDb;
use hyperlane_core::{
    ChainResult, HyperlaneDomain, HyperlaneMessage, PendingOperation, PendingOperationResult,
    PendingOperationStatus, ReprepareReason, TryBatchAs, TxCostEstimate, TxOutcome, H256, U256,
};
use lander::{Entrypoint, FullPayload, LanderError, PayloadStatus, PayloadUuid};

use crate::msg::message_processor::MessageProcessorMetrics;
use crate::msg::op_queue::OpQueue;
use crate::server::operations::message_retry::MessageRetryRequest;

// Mock QueueOperation for testing
#[derive(Debug, Serialize, Clone)]
pub struct MockQueueOperation {
    pub id: H256,
    pub status: PendingOperationStatus,
    pub destination: HyperlaneDomain,
}

impl MockQueueOperation {
    pub fn new(id: H256, status: PendingOperationStatus, destination: HyperlaneDomain) -> Self {
        Self {
            id,
            status,
            destination,
        }
    }

    pub fn with_first_prepare(id: H256) -> Self {
        let destination = HyperlaneDomain::new_test_domain("test");
        Self::new(id, PendingOperationStatus::FirstPrepareAttempt, destination)
    }

    pub fn with_manual_retry(id: H256) -> Self {
        let destination = HyperlaneDomain::new_test_domain("test");
        Self::new(
            id,
            PendingOperationStatus::Retry(ReprepareReason::Manual),
            destination,
        )
    }
}

#[async_trait]
#[typetag::serialize]
impl PendingOperation for MockQueueOperation {
    fn id(&self) -> H256 {
        self.id
    }
    fn priority(&self) -> u32 {
        0
    }
    fn origin_domain_id(&self) -> u32 {
        0
    }
    fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
        Some(self.status.clone())
    }
    fn get_operation_labels(&self) -> (String, String) {
        (
            "test_destination".to_string(),
            "test_app_context".to_string(),
        )
    }
    fn destination_domain(&self) -> &HyperlaneDomain {
        &self.destination
    }
    fn sender_address(&self) -> &H256 {
        unimplemented!()
    }
    fn recipient_address(&self) -> &H256 {
        unimplemented!()
    }
    fn body(&self) -> &[u8] {
        &[]
    }
    fn app_context(&self) -> Option<String> {
        None
    }
    fn get_metric(&self) -> Option<Arc<IntGauge>> {
        None
    }
    fn set_metric(&mut self, _metric: Arc<IntGauge>) {}
    fn status(&self) -> PendingOperationStatus {
        self.status.clone()
    }
    fn set_status(&mut self, status: PendingOperationStatus) {
        self.status = status;
    }
    async fn prepare(&mut self) -> PendingOperationResult {
        unimplemented!()
    }
    async fn submit(&mut self) -> PendingOperationResult {
        unimplemented!()
    }
    fn set_submission_outcome(&mut self, _outcome: TxOutcome) {}
    fn get_tx_cost_estimate(&self) -> Option<U256> {
        None
    }
    async fn confirm(&mut self) -> PendingOperationResult {
        unimplemented!()
    }
    async fn set_operation_outcome(
        &mut self,
        _submission_outcome: TxOutcome,
        _submission_estimated_cost: U256,
    ) {
    }
    fn next_attempt_after(&self) -> Option<Instant> {
        None
    }
    fn set_next_attempt_after(&mut self, _delay: Duration) {}
    fn reset_attempts(&mut self) {}
    #[cfg(any(test, feature = "test-utils"))]
    fn set_retries(&mut self, _retries: u32) {}
    fn get_retries(&self) -> u32 {
        0
    }
    async fn payload(&self) -> ChainResult<Vec<u8>> {
        unimplemented!()
    }
    fn success_criteria(&self) -> ChainResult<Option<Vec<u8>>> {
        unimplemented!()
    }
    fn on_reprepare(
        &mut self,
        _err_msg: Option<String>,
        _reason: ReprepareReason,
    ) -> PendingOperationResult {
        unimplemented!()
    }
}

impl TryBatchAs<HyperlaneMessage> for MockQueueOperation {}

// Mock DispatcherEntrypoint
mock! {
    pub DispatcherEntrypoint {}

    #[async_trait]
    impl Entrypoint for DispatcherEntrypoint {
        async fn send_payload(&self, payload: &FullPayload) -> Result<(), LanderError>;
        async fn payload_status(&self, payload_uuid: PayloadUuid) -> Result<PayloadStatus, LanderError>;
        async fn estimate_gas_limit(
            &self,
            payload: &FullPayload,
        ) -> Result<Option<TxCostEstimate>, LanderError>;
    }
}

/// Helper function to create a test queue for testing
pub fn create_test_queue() -> OpQueue {
    let metrics = IntGaugeVec::new(
        prometheus::opts!("test_queue_length", "Test queue length"),
        &[
            "destination",
            "queue_metrics_label",
            "operation_status",
            "app_context",
        ],
    )
    .unwrap();
    let (tx, rx) = broadcast::channel::<MessageRetryRequest>(10);
    drop(tx);
    OpQueue::new(
        metrics,
        "test_confirm_queue".to_string(),
        Arc::new(tokio::sync::Mutex::new(rx)),
    )
}

/// Helper function to create test metrics for testing
pub fn create_test_metrics() -> MessageProcessorMetrics {
    use prometheus::{IntCounterVec, Opts};

    let processor_queue_length = IntGaugeVec::new(
        Opts::new("test_processor_queue_length", "Test processor queue length"),
        &[
            "destination",
            "queue_metrics_label",
            "operation_status",
            "app_context",
        ],
    )
    .unwrap();

    let ops_processed = IntCounterVec::new(
        Opts::new("test_ops_processed", "Test operations processed"),
        &["chain", "phase", "app_context"],
    )
    .unwrap();

    MessageProcessorMetrics {
        destination: "test".to_string(),
        processor_queue_length,
        ops_prepared: ops_processed.clone(),
        ops_submitted: ops_processed.clone(),
        ops_confirmed: ops_processed.clone(),
        ops_failed: ops_processed.clone(),
        ops_dropped: ops_processed.clone(),
    }
}
