// Common test utilities for message processor tests

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mockall::mock;
use prometheus::{IntGauge, IntGaugeVec};
use serde::Serialize;
use tokio::sync::broadcast;

use hyperlane_base::db::{
    DbResult, HyperlaneDb, InterchainGasExpenditureData, InterchainGasPaymentData,
};
use hyperlane_core::{
    identifiers::UniqueIdentifier, ChainResult, GasPaymentKey, HyperlaneDomain, HyperlaneMessage,
    InterchainGasPayment, InterchainGasPaymentMeta, MerkleTreeInsertion, PendingOperation,
    PendingOperationResult, PendingOperationStatus, ReprepareReason, TryBatchAs, TxOutcome, H256,
    U256,
};
use lander::{Entrypoint, FullPayload, LanderError, PayloadStatus, PayloadUuid};

use crate::msg::op_queue::OpQueue;
use crate::server::operations::message_retry::MessageRetryRequest;

// Mock QueueOperation for testing
#[derive(Debug, Serialize, Clone)]
pub struct MockQueueOperation {
    pub id: H256,
    pub status: PendingOperationStatus,
}

impl MockQueueOperation {
    pub fn new(id: H256, status: PendingOperationStatus) -> Self {
        Self { id, status }
    }

    pub fn with_first_prepare(id: H256) -> Self {
        Self::new(id, PendingOperationStatus::FirstPrepareAttempt)
    }

    pub fn with_manual_retry(id: H256) -> Self {
        Self::new(id, PendingOperationStatus::Retry(ReprepareReason::Manual))
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
        unimplemented!()
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

// Mock HyperlaneDb
mock! {
    pub HyperlaneDb {}

    impl HyperlaneDb for HyperlaneDb {
        fn retrieve_payload_uuids_by_message_id(
            &self,
            message_id: &H256,
        ) -> DbResult<Option<Vec<PayloadUuid>>>;
        fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>>;
        fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;
        fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>>;
        fn domain(&self) -> &HyperlaneDomain;
        fn store_message_id_by_nonce(&self, nonce: &u32, id: &H256) -> DbResult<()>;
        fn retrieve_message_id_by_nonce(&self, nonce: &u32) -> DbResult<Option<H256>>;
        fn store_message_by_id(&self, id: &H256, message: &HyperlaneMessage) -> DbResult<()>;
        fn retrieve_message_by_id(&self, id: &H256) -> DbResult<Option<HyperlaneMessage>>;
        fn store_dispatched_block_number_by_nonce(
            &self,
            nonce: &u32,
            block_number: &u64,
        ) -> DbResult<()>;
        fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>>;
        fn store_processed_by_nonce(&self, nonce: &u32, processed: &bool) -> DbResult<()>;
        fn store_processed_by_gas_payment_meta(
            &self,
            meta: &InterchainGasPaymentMeta,
            processed: &bool,
        ) -> DbResult<()>;
        fn retrieve_processed_by_gas_payment_meta(
            &self,
            meta: &InterchainGasPaymentMeta,
        ) -> DbResult<Option<bool>>;
        fn store_interchain_gas_expenditure_data_by_message_id(
            &self,
            message_id: &H256,
            data: &InterchainGasExpenditureData,
        ) -> DbResult<()>;
        fn retrieve_interchain_gas_expenditure_data_by_message_id(
            &self,
            message_id: &H256,
        ) -> DbResult<Option<InterchainGasExpenditureData>>;
        fn store_status_by_message_id(
            &self,
            message_id: &H256,
            status: &PendingOperationStatus,
        ) -> DbResult<()>;
        fn retrieve_status_by_message_id(
            &self,
            message_id: &H256,
        ) -> DbResult<Option<PendingOperationStatus>>;
        fn store_interchain_gas_payment_data_by_gas_payment_key(
            &self,
            key: &GasPaymentKey,
            data: &InterchainGasPaymentData,
        ) -> DbResult<()>;
        fn retrieve_interchain_gas_payment_data_by_gas_payment_key(
            &self,
            key: &GasPaymentKey,
        ) -> DbResult<Option<InterchainGasPaymentData>>;
        fn store_gas_payment_by_sequence(
            &self,
            sequence: &u32,
            payment: &InterchainGasPayment,
        ) -> DbResult<()>;
        fn retrieve_gas_payment_by_sequence(
            &self,
            sequence: &u32,
        ) -> DbResult<Option<InterchainGasPayment>>;
        fn store_gas_payment_block_by_sequence(
            &self,
            sequence: &u32,
            block_number: &u64,
        ) -> DbResult<()>;
        fn retrieve_gas_payment_block_by_sequence(&self, sequence: &u32) -> DbResult<Option<u64>>;
        fn store_pending_message_retry_count_by_message_id(
            &self,
            message_id: &H256,
            count: &u32,
        ) -> DbResult<()>;
        fn retrieve_pending_message_retry_count_by_message_id(
            &self,
            message_id: &H256,
        ) -> DbResult<Option<u32>>;
        fn store_merkle_tree_insertion_by_leaf_index(
            &self,
            leaf_index: &u32,
            insertion: &MerkleTreeInsertion,
        ) -> DbResult<()>;
        fn retrieve_merkle_tree_insertion_by_leaf_index(
            &self,
            leaf_index: &u32,
        ) -> DbResult<Option<MerkleTreeInsertion>>;
        fn store_merkle_leaf_index_by_message_id(
            &self,
            message_id: &H256,
            leaf_index: &u32,
        ) -> DbResult<()>;
        fn retrieve_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<Option<u32>>;
        fn store_merkle_tree_insertion_block_number_by_leaf_index(
            &self,
            leaf_index: &u32,
            block_number: &u64,
        ) -> DbResult<()>;
        fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
            &self,
            leaf_index: &u32,
        ) -> DbResult<Option<u64>>;
        fn store_highest_seen_message_nonce_number(&self, nonce: &u32) -> DbResult<()>;
        fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>>;
        fn store_payload_uuids_by_message_id(
            &self,
            message_id: &H256,
            payloads_uuid: Vec<UniqueIdentifier>,
        ) -> DbResult<()>;
    }
}

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
        ) -> Result<Option<U256>, LanderError>;
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
