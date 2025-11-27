use std::sync::Arc;

use uuid::Uuid;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::{identifiers::UniqueIdentifier, QueueOperation, H256};
use lander::{
    Entrypoint, LanderError, PayloadDropReason, PayloadRetryReason, PayloadStatus,
    TransactionDropReason, TransactionStatus,
};

use crate::msg::message_processor::tests::tests_common::{
    create_test_metrics, create_test_queue, MockDispatcherEntrypoint, MockHyperlaneDb,
    MockQueueOperation,
};

use super::filter_operations_for_submit;

#[tokio::test]
async fn test_filter_operations_for_submit_empty_batch() {
    let mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let batch = vec![];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(result.len(), 0, "Empty batch should return empty result");

    // Verify queues are empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_all_pending_inclusion() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let message_id1 = H256::from_low_u64_be(1);
    let message_id2 = H256::from_low_u64_be(2);

    let payload_uuid1 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid1_clone = payload_uuid1.clone();
    let payload_uuid2_clone = payload_uuid2.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(2)
        .returning(move |id| {
            if *id == message_id1 {
                Ok(Some(vec![payload_uuid1_clone.clone()]))
            } else if *id == message_id2 {
                Ok(Some(vec![payload_uuid2_clone.clone()]))
            } else {
                Ok(None)
            }
        });

    mock_entrypoint
        .expect_payload_status()
        .times(2)
        .returning(|_| {
            Ok(PayloadStatus::InTransaction(
                TransactionStatus::PendingInclusion,
            ))
        });

    let op1 = Box::new(MockQueueOperation::with_first_prepare(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;

    let batch = vec![op1, op2];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Pending inclusion operations should be re-queued to submit queue, not returned"
    );

    // Verify submit queue has 2 operations re-queued
    assert_eq!(submit_queue.len().await, 2);

    // Verify confirm queue is empty
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_filter_operations_for_submit_all_finalized() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let message_id1 = H256::from_low_u64_be(1);
    let message_id2 = H256::from_low_u64_be(2);

    let payload_uuid1 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid1_clone = payload_uuid1.clone();
    let payload_uuid2_clone = payload_uuid2.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(2)
        .returning(move |id| {
            if *id == message_id1 {
                Ok(Some(vec![payload_uuid1_clone.clone()]))
            } else if *id == message_id2 {
                Ok(Some(vec![payload_uuid2_clone.clone()]))
            } else {
                Ok(None)
            }
        });

    mock_entrypoint
        .expect_payload_status()
        .times(2)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized)));

    let op1 = Box::new(MockQueueOperation::with_first_prepare(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;

    let batch = vec![op1, op2];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Finalized operations should move to confirm queue, not returned"
    );

    // Verify confirm queue has 2 operations
    assert_eq!(confirm_queue.len().await, 2);

    // Verify submit queue is empty
    assert_eq!(submit_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_payload_dropped() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

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

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Dropped operation should not be returned (PostSubmitFailure goes to confirm queue)"
    );

    // Verify dropped operation moved to confirm queue
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(
        confirm_queue.len().await,
        1,
        "Dropped operation should be in confirm queue for delivery check"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_filter_operations_for_submit_mixed_batch() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let message_id1 = H256::from_low_u64_be(1); // Dropped - should go to confirm (PostSubmitFailure)
    let message_id2 = H256::from_low_u64_be(2); // PendingInclusion - should be re-queued to submit
    let message_id3 = H256::from_low_u64_be(3); // Finalized - should go to confirm (PostSubmitSuccess)

    let payload_uuid1 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid3 = UniqueIdentifier::new(Uuid::new_v4());

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

    let payload_uuid1_for_ep = payload_uuid1.clone();
    let payload_uuid2_for_ep = payload_uuid2.clone();
    let payload_uuid3_for_ep = payload_uuid3.clone();
    mock_entrypoint
        .expect_payload_status()
        .times(3)
        .returning(move |uuid| {
            if *uuid == *payload_uuid1_for_ep {
                Ok(PayloadStatus::InTransaction(TransactionStatus::Dropped(
                    TransactionDropReason::FailedSimulation,
                )))
            } else if *uuid == *payload_uuid2_for_ep {
                Ok(PayloadStatus::InTransaction(
                    TransactionStatus::PendingInclusion,
                ))
            } else if *uuid == *payload_uuid3_for_ep {
                Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized))
            } else {
                Err(LanderError::PayloadNotFound)
            }
        });

    let op1 = Box::new(MockQueueOperation::with_first_prepare(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;
    let op3 = Box::new(MockQueueOperation::with_first_prepare(message_id3)) as QueueOperation;

    let batch = vec![op1, op2, op3];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "No operations should be returned (PostSubmitFailure goes to confirm queue)"
    );

    // Verify submit queue has 1 operation (pending inclusion re-queued)
    assert_eq!(submit_queue.len().await, 1);

    // Verify confirm queue has 2 operations (dropped + finalized)
    assert_eq!(
        confirm_queue.len().await,
        2,
        "Both dropped and finalized operations should be in confirm queue"
    );
}

#[tokio::test]
async fn test_filter_operations_for_submit_retry_status() {
    // Test that Retry status (e.g., Reorged) goes to confirm queue (PostSubmitFailure)
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

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
        .returning(|_| Ok(PayloadStatus::Retry(PayloadRetryReason::Reorged)));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Retry (Reorged) operation should not be returned (PostSubmitFailure goes to confirm queue)"
    );

    // Verify operation moved to confirm queue
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(
        confirm_queue.len().await,
        1,
        "Retry operation should be in confirm queue for delivery check"
    );
}

#[tokio::test]
async fn test_filter_operations_for_submit_db_error() {
    // Test that DB error returns operation for resubmission
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let message_id = H256::from_low_u64_be(1);

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| {
            Err(hyperlane_base::db::DbError::Other(
                "Database error".to_string(),
            ))
        });

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "DB error should return operation for resubmission"
    );

    // Verify queues are empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_entrypoint_error_payload_not_found() {
    // Test that PayloadNotFound error returns operation for resubmission
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

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

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "PayloadNotFound error should return operation for resubmission"
    );

    // Verify queues are empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_entrypoint_error_network() {
    // Test that NetworkError returns operation for resubmission
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

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
        .returning(|_| Err(LanderError::NetworkError("Connection timeout".to_string())));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "NetworkError should return operation for resubmission"
    );

    // Verify queues are empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_no_payload_uuids() {
    // Test that no payload UUIDs returns operation for resubmission
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let message_id = H256::from_low_u64_be(1);

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(None));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "No payload UUIDs should return operation for resubmission"
    );

    // Verify queues are empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_empty_payload_uuids() {
    // Test that empty payload UUIDs list returns operation for resubmission
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let message_id = H256::from_low_u64_be(1);

    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(Some(vec![])));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Empty payload UUIDs should return operation for resubmission"
    );

    // Verify queues are empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_all_payload_drop_reasons() {
    // Test that all PayloadDropReason variants go to confirm queue (PostSubmitFailure)
    let test_cases = vec![
        (
            "FailedToBuildAsTransaction",
            PayloadDropReason::FailedToBuildAsTransaction,
        ),
        ("FailedSimulation", PayloadDropReason::FailedSimulation),
        ("Reverted", PayloadDropReason::Reverted),
        ("UnhandledError", PayloadDropReason::UnhandledError),
    ];

    for (test_name, drop_reason) in test_cases {
        let mut mock_db = MockHyperlaneDb::new();
        let mut mock_entrypoint = MockDispatcherEntrypoint::new();
        let submit_queue = create_test_queue();
        let confirm_queue = create_test_queue();
        let metrics = create_test_metrics();

        let message_id = H256::from_low_u64_be(1);
        let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

        let payload_uuid_clone = payload_uuid.clone();
        mock_db
            .expect_retrieve_payload_uuids_by_message_id()
            .times(1)
            .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

        let drop_reason_clone = drop_reason.clone();
        mock_entrypoint
            .expect_payload_status()
            .times(1)
            .returning(move |_| Ok(PayloadStatus::Dropped(drop_reason_clone.clone())));

        let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
        let batch = vec![op];

        let result = filter_operations_for_submit(
            Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
            &submit_queue,
            &confirm_queue,
            &metrics,
            Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
            batch,
        )
        .await;

        assert_eq!(
            result.len(),
            0,
            "{} should not return operation (PostSubmitFailure goes to confirm queue)",
            test_name
        );

        assert_eq!(submit_queue.len().await, 0);
        assert_eq!(
            confirm_queue.len().await,
            1,
            "{} should send operation to confirm queue",
            test_name
        );
    }
}

#[tokio::test]
async fn test_filter_operations_for_submit_all_transaction_drop_reasons() {
    // Test that all TransactionDropReason variants go to confirm queue (PostSubmitFailure)
    let test_cases = vec![
        ("DroppedByChain", TransactionDropReason::DroppedByChain),
        ("FailedSimulation", TransactionDropReason::FailedSimulation),
    ];

    for (test_name, drop_reason) in test_cases {
        let mut mock_db = MockHyperlaneDb::new();
        let mut mock_entrypoint = MockDispatcherEntrypoint::new();
        let submit_queue = create_test_queue();
        let confirm_queue = create_test_queue();
        let metrics = create_test_metrics();

        let message_id = H256::from_low_u64_be(1);
        let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

        let payload_uuid_clone = payload_uuid.clone();
        mock_db
            .expect_retrieve_payload_uuids_by_message_id()
            .times(1)
            .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

        let drop_reason_clone = drop_reason.clone();
        mock_entrypoint
            .expect_payload_status()
            .times(1)
            .returning(move |_| {
                Ok(PayloadStatus::InTransaction(TransactionStatus::Dropped(
                    drop_reason_clone.clone(),
                )))
            });

        let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
        let batch = vec![op];

        let result = filter_operations_for_submit(
            Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
            &submit_queue,
            &confirm_queue,
            &metrics,
            Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
            batch,
        )
        .await;

        assert_eq!(
            result.len(),
            0,
            "{} should not return operation (PostSubmitFailure goes to confirm queue)",
            test_name
        );

        assert_eq!(submit_queue.len().await, 0);
        assert_eq!(
            confirm_queue.len().await,
            1,
            "{} should send operation to confirm queue",
            test_name
        );
    }
}

#[tokio::test]
async fn test_filter_operations_for_submit_ready_to_submit_status() {
    // Test that ReadyToSubmit status re-queues operation to submit queue
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

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
        .returning(|_| Ok(PayloadStatus::ReadyToSubmit));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "ReadyToSubmit operation should be re-queued to submit queue, not returned"
    );

    // Verify operation was re-queued to submit queue
    assert_eq!(submit_queue.len().await, 1);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_mempool_status() {
    // Test that Mempool status re-queues operation to submit queue
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

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
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Mempool)));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Mempool operation should be re-queued to submit queue, not returned"
    );

    // Verify operation was re-queued to submit queue
    assert_eq!(submit_queue.len().await, 1);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_submit_all_submit_variants() {
    // Test batch with all three Submit disposition variants (ReadyToSubmit, PendingInclusion, Mempool)
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    let message_id1 = H256::from_low_u64_be(1); // ReadyToSubmit
    let message_id2 = H256::from_low_u64_be(2); // PendingInclusion
    let message_id3 = H256::from_low_u64_be(3); // Mempool

    let payload_uuid1 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid3 = UniqueIdentifier::new(Uuid::new_v4());

    // Mock DB to return payload UUIDs for all operations
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

    // Mock entrypoint to return different Submit disposition statuses
    let payload_uuid1_for_ep = payload_uuid1.clone();
    let payload_uuid2_for_ep = payload_uuid2.clone();
    let payload_uuid3_for_ep = payload_uuid3.clone();
    mock_entrypoint
        .expect_payload_status()
        .times(3)
        .returning(move |uuid| {
            if *uuid == *payload_uuid1_for_ep {
                Ok(PayloadStatus::ReadyToSubmit)
            } else if *uuid == *payload_uuid2_for_ep {
                Ok(PayloadStatus::InTransaction(
                    TransactionStatus::PendingInclusion,
                ))
            } else if *uuid == *payload_uuid3_for_ep {
                Ok(PayloadStatus::InTransaction(TransactionStatus::Mempool))
            } else {
                Err(LanderError::PayloadNotFound)
            }
        });

    let op1 = Box::new(MockQueueOperation::with_first_prepare(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;
    let op3 = Box::new(MockQueueOperation::with_first_prepare(message_id3)) as QueueOperation;

    let batch = vec![op1, op2, op3];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "All Submit disposition variants should be re-queued to submit queue, not returned"
    );

    // Verify all 3 operations were re-queued to submit queue
    assert_eq!(
        submit_queue.len().await,
        3,
        "All 3 Submit disposition variants (ReadyToSubmit, PendingInclusion, Mempool) should be re-queued"
    );
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_filter_operations_for_submit_included_status() {
    // Test that Included status (not just Finalized) moves operation to confirm queue
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

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
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Included)));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_submit(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        &metrics,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Included operation should move to confirm queue, not returned"
    );

    // Verify operation moved to confirm queue
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 1);
}
