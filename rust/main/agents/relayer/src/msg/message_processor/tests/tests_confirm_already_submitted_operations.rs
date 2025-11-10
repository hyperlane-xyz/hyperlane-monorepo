use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mockall::mock;
use prometheus::{IntGauge, IntGaugeVec};
use serde::Serialize;
use tokio::sync::broadcast;
use uuid::Uuid;

use hyperlane_base::db::{
    DbResult, HyperlaneDb, InterchainGasExpenditureData, InterchainGasPaymentData,
};
use hyperlane_core::{
    identifiers::UniqueIdentifier, ChainResult, GasPaymentKey, HyperlaneDomain, HyperlaneMessage,
    InterchainGasPayment, InterchainGasPaymentMeta, MerkleTreeInsertion, PendingOperation,
    PendingOperationResult, PendingOperationStatus, QueueOperation, ReprepareReason, TryBatchAs,
    TxOutcome, H256, U256,
};
use lander::{
    Entrypoint, FullPayload, LanderError, PayloadDropReason, PayloadStatus, PayloadUuid,
    TransactionDropReason, TransactionStatus,
};

use crate::msg::op_queue::OpQueue;
use crate::server::operations::message_retry::MessageRetryRequest;

use super::super::confirm_already_submitted_operations;

// Mock QueueOperation for testing
#[derive(Debug, Serialize, Clone)]
struct MockQueueOperation {
    id: H256,
    status: PendingOperationStatus,
}

impl MockQueueOperation {
    fn new(id: H256, status: PendingOperationStatus) -> Self {
        Self { id, status }
    }

    fn with_first_prepare(id: H256) -> Self {
        Self::new(id, PendingOperationStatus::FirstPrepareAttempt)
    }

    fn with_manual_retry(id: H256) -> Self {
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

fn create_test_queue() -> OpQueue {
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

#[tokio::test]
async fn test_confirm_already_submitted_operations_empty_batch() {
    let mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let batch = vec![];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(result.len(), 0, "Empty batch should return empty result");

    // Verify confirm queue is empty for empty batch
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty for empty batch"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_all_manual_retry() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    // DB and entrypoint should NOT be called for manual retry (early return optimization)
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(0);

    mock_entrypoint.expect_payload_status().times(0);

    let op1 = Box::new(MockQueueOperation::with_manual_retry(
        H256::from_low_u64_be(1),
    )) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_manual_retry(
        H256::from_low_u64_be(2),
    )) as QueueOperation;
    let op3 = Box::new(MockQueueOperation::with_manual_retry(
        H256::from_low_u64_be(3),
    )) as QueueOperation;

    let batch = vec![op1, op2, op3];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        3,
        "All manual retry operations should be returned for prepare"
    );

    // Verify confirm queue is empty for manual retry operations
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty for manual retry operations"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_all_submitted() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id1 = H256::from_low_u64_be(1);
    let message_id2 = H256::from_low_u64_be(2);
    let message_id3 = H256::from_low_u64_be(3);

    let payload_uuid1 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid3 = UniqueIdentifier::new(Uuid::new_v4());

    // Mock DB to return payload UUIDs - use a single expectation that handles all cases
    let payload_uuid1_clone = payload_uuid1.clone();
    let payload_uuid2_clone = payload_uuid2.clone();
    let payload_uuid3_clone = payload_uuid3.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(3)
        .returning(move |id| {
            if *id == message_id1 {
                Ok(Some(vec![payload_uuid1_clone.clone()]))
            } else if *id == message_id2 {
                Ok(Some(vec![payload_uuid2_clone.clone()]))
            } else if *id == message_id3 {
                Ok(Some(vec![payload_uuid3_clone.clone()]))
            } else {
                Ok(None)
            }
        });

    // Mock entrypoint to return finalized status for all
    mock_entrypoint
        .expect_payload_status()
        .times(3)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized)));

    let op1 = Box::new(MockQueueOperation::with_first_prepare(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;
    let op3 = Box::new(MockQueueOperation::with_first_prepare(message_id3)) as QueueOperation;

    let batch = vec![op1, op2, op3];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "All submitted operations should go to confirm queue, not prepare"
    );

    // Verify all 3 operations were pushed to confirm queue
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        3,
        "All 3 operations should be in confirm queue"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_none_submitted() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id1 = H256::from_low_u64_be(1);
    let message_id2 = H256::from_low_u64_be(2);

    // Mock DB to return no payload UUIDs
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(2)
        .returning(|_| Ok(None));

    // Entrypoint should NOT be called when DB returns None (early return optimization)
    mock_entrypoint.expect_payload_status().times(0);

    let op1 = Box::new(MockQueueOperation::with_first_prepare(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;

    let batch = vec![op1, op2];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        2,
        "All non-submitted operations should be returned for prepare"
    );

    // Verify confirm queue is empty when no operations are submitted
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty when no operations are submitted"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_mixed_batch() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id1 = H256::from_low_u64_be(1); // Manual retry - should go to prepare
    let message_id2 = H256::from_low_u64_be(2); // Submitted - should go to confirm
    let message_id3 = H256::from_low_u64_be(3); // Not submitted - should go to prepare
    let message_id4 = H256::from_low_u64_be(4); // Submitted - should go to confirm

    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid4 = UniqueIdentifier::new(Uuid::new_v4());

    // Mock DB with flexible expectation handling all operations
    let payload_uuid2_clone = payload_uuid2.clone();
    let payload_uuid4_clone = payload_uuid4.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(3) // Op1 has manual retry (not called), Op2, Op3, Op4
        .returning(move |id| {
            if *id == message_id2 {
                Ok(Some(vec![payload_uuid2_clone.clone()]))
            } else if *id == message_id3 {
                Ok(None)
            } else if *id == message_id4 {
                Ok(Some(vec![payload_uuid4_clone.clone()]))
            } else {
                Ok(None)
            }
        });

    // Mock entrypoint with flexible expectation
    let payload_uuid2_for_ep = payload_uuid2.clone();
    let payload_uuid4_for_ep = payload_uuid4.clone();
    mock_entrypoint
        .expect_payload_status()
        .times(2) // Op2 and Op4
        .returning(move |uuid| {
            if *uuid == *payload_uuid2_for_ep {
                Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized))
            } else if *uuid == *payload_uuid4_for_ep {
                Ok(PayloadStatus::InTransaction(
                    TransactionStatus::PendingInclusion,
                ))
            } else {
                Err(LanderError::PayloadNotFound)
            }
        });

    let op1 = Box::new(MockQueueOperation::with_manual_retry(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;
    let op3 = Box::new(MockQueueOperation::with_first_prepare(message_id3)) as QueueOperation;
    let op4 = Box::new(MockQueueOperation::with_first_prepare(message_id4)) as QueueOperation;

    let batch = vec![op1, op2, op3, op4];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        2,
        "2 operations (manual retry + not submitted) should be returned for prepare"
    );

    // Verify the IDs of operations to prepare
    let result_ids: Vec<H256> = result.iter().map(|op| op.id()).collect();
    assert!(
        result_ids.contains(&message_id1),
        "Manual retry operation should be in prepare list"
    );
    assert!(
        result_ids.contains(&message_id3),
        "Not submitted operation should be in prepare list"
    );

    // Verify the 2 submitted operations (op2 and op4) were pushed to confirm queue
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        2,
        "2 submitted operations should be in confirm queue"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_db_error() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);

    // Mock DB to return an error
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| {
            Err(hyperlane_base::db::DbError::Other(
                "Database error".to_string(),
            ))
        });

    // Entrypoint should NOT be called when DB returns error (early return optimization)
    mock_entrypoint.expect_payload_status().times(0);

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with DB error should be returned for prepare"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify confirm queue is empty when DB error occurs
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty when DB error occurs"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_payload_dropped() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid_clone = payload_uuid.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .times(1)
        .returning(|_| Ok(PayloadStatus::Dropped(PayloadDropReason::FailedSimulation)));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with dropped payload should be returned for prepare"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify confirm queue is empty when payload is dropped
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty when payload is dropped"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_transaction_dropped() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid_clone = payload_uuid.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .times(1)
        .returning(|_| {
            Ok(PayloadStatus::InTransaction(TransactionStatus::Dropped(
                TransactionDropReason::FailedSimulation,
            )))
        });

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with dropped transaction should be returned for prepare"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify confirm queue is empty when transaction is dropped
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty when transaction is dropped"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_entrypoint_error() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid_clone = payload_uuid.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .times(1)
        .returning(|_| Err(LanderError::PayloadNotFound));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with entrypoint error should be returned for prepare"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify confirm queue is empty when entrypoint returns error
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty when entrypoint returns error"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_non_manual_retry() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

    // Non-manual retry should go through normal flow (call DB and entrypoint)
    let payload_uuid_clone = payload_uuid.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .times(1)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized)));

    // Use ErrorSubmitting as an example of non-manual retry
    let op = Box::new(MockQueueOperation::new(
        message_id,
        PendingOperationStatus::Retry(ReprepareReason::ErrorSubmitting),
    )) as QueueOperation;
    let batch = vec![op];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Non-manual retry operation that was submitted should go to confirm queue"
    );

    // Verify the operation was pushed to confirm queue
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        1,
        "Operation should be in confirm queue"
    );
}

#[tokio::test]
async fn test_confirm_already_submitted_operations_empty_payload_uuids() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);

    // Mock DB to return empty list (distinct from None)
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(Some(vec![])));

    // Entrypoint should NOT be called when DB returns empty list (early return optimization)
    mock_entrypoint.expect_payload_status().times(0);

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = confirm_already_submitted_operations(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with empty payload UUIDs should be returned for prepare"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify confirm queue is empty when payload UUIDs list is empty
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(
        queue_contents.len(),
        0,
        "Confirm queue should be empty when payload UUIDs list is empty"
    );
}
