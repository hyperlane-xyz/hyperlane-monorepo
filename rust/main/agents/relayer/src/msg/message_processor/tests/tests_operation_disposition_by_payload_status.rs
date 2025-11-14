use std::sync::Arc;

use uuid::Uuid;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::{identifiers::UniqueIdentifier, QueueOperation, H256};
use lander::{
    Entrypoint, LanderError, PayloadDropReason, PayloadRetryReason, PayloadStatus,
    TransactionDropReason, TransactionStatus,
};

use super::super::{operation_disposition_by_payload_status, OperationDisposition};
use super::tests_common::{MockDispatcherEntrypoint, MockHyperlaneDb, MockQueueOperation};

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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Should return PreSubmit when db returns error"
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Should return PreSubmit when no payload UUIDs exist"
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Should return PreSubmit when payload UUIDs list is empty"
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Should return PreSubmit when payload status is Dropped"
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Should return PreSubmit when transaction status is Dropped"
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmit),
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmit),
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Should return PreSubmit when entrypoint returns error"
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmit),
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmit),
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmit),
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmit),
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

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = operation_disposition_by_payload_status(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmit),
        "Should return Confirm when transaction is included in unfinalized block"
    );
}
