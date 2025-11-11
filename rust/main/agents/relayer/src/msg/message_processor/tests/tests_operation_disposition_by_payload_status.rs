use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mockall::mock;
use prometheus::IntGauge;
use serde::Serialize;
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
    Entrypoint, FullPayload, LanderError, PayloadDropReason, PayloadRetryReason, PayloadStatus,
    PayloadUuid, TransactionDropReason, TransactionStatus,
};

use super::super::{operation_disposition_by_payload_status, OperationDisposition};

// Mock QueueOperation for testing
#[derive(Debug, Serialize)]
struct MockQueueOperation {
    id: H256,
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
        None
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
        PendingOperationStatus::FirstPrepareAttempt
    }
    fn set_status(&mut self, _status: PendingOperationStatus) {}
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

#[tokio::test]
async fn test_operation_disposition_by_payload_status_db_error() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(1);
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(|_| {
            Err(hyperlane_base::db::DbError::Other(
                "Database error".to_string(),
            ))
        });

    // Entrypoint should NOT be called when DB fails (early return optimization)
    mock_entrypoint.expect_payload_status().times(0);

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Prepare),
        "Should return Prepare when db returns error"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_no_payload_uuids() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(2);
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(|_| Ok(None));

    // Entrypoint should NOT be called when no payload UUIDs exist (early return optimization)
    mock_entrypoint.expect_payload_status().times(0);

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Prepare),
        "Should return Prepare when no payload UUIDs exist"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_empty_payload_uuids() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(3);
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(|_| Ok(Some(vec![])));

    // Entrypoint should NOT be called when payload UUIDs list is empty (early return optimization)
    mock_entrypoint.expect_payload_status().times(0);

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Prepare),
        "Should return Prepare when payload UUIDs list is empty"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_payload_dropped() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(4);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid_for_db = payload_uuid.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    let payload_uuid_for_ep = payload_uuid.clone();
    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| Ok(PayloadStatus::Dropped(PayloadDropReason::FailedSimulation)));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Prepare),
        "Should return Prepare when payload status is Dropped"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_transaction_dropped() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(5);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| {
            Ok(PayloadStatus::InTransaction(TransactionStatus::Dropped(
                TransactionDropReason::FailedSimulation,
            )))
        });

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Prepare),
        "Should return Prepare when transaction status is Dropped"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_success_pending_inclusion() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(6);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| {
            Ok(PayloadStatus::InTransaction(
                TransactionStatus::PendingInclusion,
            ))
        });

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Confirm),
        "Should return Confirm when transaction is pending inclusion"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_success_finalized() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(7);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized)));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Confirm),
        "Should return Confirm when transaction is finalized"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_entrypoint_error() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(8);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| Err(LanderError::PayloadNotFound));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Prepare),
        "Should return Prepare when entrypoint returns error"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_multiple_payload_uuids() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(9);
    let payload_uuid1 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid1_clone = payload_uuid1.clone();
    let payload_uuid2_clone = payload_uuid2.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .returning(move |_| {
            Ok(Some(vec![
                payload_uuid1_clone.clone(),
                payload_uuid2_clone.clone(),
            ]))
        });

    // Should only check the first UUID
    let payload_uuid1_clone2 = payload_uuid1.clone();
    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid1_clone2))
        .times(1)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized)));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Confirm),
        "Should return Confirm when checking first payload UUID in list"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_ready_to_submit() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(10);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| Ok(PayloadStatus::ReadyToSubmit));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Confirm),
        "Should return Confirm when payload status is ReadyToSubmit"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_retry() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(11);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| Ok(PayloadStatus::Retry(PayloadRetryReason::Reorged)));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Confirm),
        "Should return Confirm when payload is being retried (was previously submitted)"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_transaction_mempool() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(12);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Mempool)));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Confirm),
        "Should return Confirm when transaction is in mempool (accepted by node)"
    );
}

#[tokio::test]
async fn test_operation_disposition_by_payload_status_transaction_included() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(13);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid_for_db = payload_uuid.clone();
    let payload_uuid_for_ep = payload_uuid.clone();

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .with(mockall::predicate::eq(message_id))
        .times(1)
        .returning(move |_| Ok(Some(vec![payload_uuid_for_db.clone()])));

    mock_entrypoint
        .expect_payload_status()
        .with(mockall::predicate::eq(payload_uuid_for_ep))
        .times(1)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Included)));

    let op = Box::new(MockQueueOperation { id: message_id }) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::Confirm),
        "Should return Confirm when transaction is included in unfinalized block"
    );
}
