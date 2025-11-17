use std::sync::Arc;

use uuid::Uuid;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_base::tests::mock_hyperlane_db::MockHyperlaneDb;
use hyperlane_core::identifiers::UniqueIdentifier;
use hyperlane_core::{
    HyperlaneDomain, PendingOperationStatus, QueueOperation, ReprepareReason, H256,
};
use lander::{
    Entrypoint, LanderError, PayloadDropReason, PayloadStatus, TransactionDropReason,
    TransactionStatus,
};

use crate::msg::message_processor::tests::tests_common::{
    create_test_queue, MockDispatcherEntrypoint, MockQueueOperation,
};

use super::super::filter_operations_for_preparation;

#[tokio::test]
async fn test_filter_operations_for_preparation_empty_batch() {
    let mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();

    let batch = vec![];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(result.len(), 0, "Empty batch should return empty result");

    // Verify queues are empty for empty batch
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_all_manual_retry() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();

    // Store should be called to remove the payload UUID mapping for each manual operation
    mock_db
        .expect_store_payload_uuids_by_message_id()
        .times(3)
        .returning(|_, _| Ok(()));

    // After clearing, retrieve IS called for each operation by operation_disposition_by_payload_status
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(3)
        .returning(|_| Ok(None));

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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        3,
        "All manual retry operations should be returned for pre-submit"
    );

    // Verify queues are empty for manual retry operations
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_manual_retry_db_store_failure() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();

    // Store should be called but will fail
    mock_db
        .expect_store_payload_uuids_by_message_id()
        .times(2)
        .returning(|_, _| {
            Err(hyperlane_base::db::DbError::Other(
                "Mock DB store failure".to_string(),
            ))
        });

    // After store failure, retrieve IS still called by operation_disposition_by_payload_status
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(2)
        .returning(|_| Ok(None));

    mock_entrypoint.expect_payload_status().times(0);

    let op1 = Box::new(MockQueueOperation::with_manual_retry(
        H256::from_low_u64_be(1),
    )) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_manual_retry(
        H256::from_low_u64_be(2),
    )) as QueueOperation;

    let batch = vec![op1, op2];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        2,
        "Manual retry operations should still be returned for pre-submit even if DB store fails"
    );

    // Verify queues are empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_manual_retry_db_store_failure_mixed_batch() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();

    let message_id1 = H256::from_low_u64_be(1); // Manual retry with DB store failure
    let message_id2 = H256::from_low_u64_be(2); // Submitted - should go to confirm
    let message_id3 = H256::from_low_u64_be(3); // Not submitted - should go to pre-submit

    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());

    // Store should be called for manual operation and fail
    mock_db
        .expect_store_payload_uuids_by_message_id()
        .times(1)
        .returning(|_, _| {
            Err(hyperlane_base::db::DbError::Other(
                "Mock DB store failure".to_string(),
            ))
        });

    // DB retrieval for all operations (including manual after store failure)
    let payload_uuid2_clone = payload_uuid2.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(3) // Op1 (manual), Op2, and Op3
        .returning(move |id| {
            if *id == message_id2 {
                Ok(Some(vec![payload_uuid2_clone.clone()]))
            } else if *id == message_id3 {
                Ok(None)
            } else {
                Ok(None) // Op1 manual returns None
            }
        });

    // Mock entrypoint
    let payload_uuid2_for_ep = payload_uuid2.clone();
    mock_entrypoint
        .expect_payload_status()
        .times(1) // Only Op2
        .returning(move |uuid| {
            if *uuid == *payload_uuid2_for_ep {
                Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized))
            } else {
                Err(LanderError::PayloadNotFound)
            }
        });

    let op1 = Box::new(MockQueueOperation::with_manual_retry(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;
    let op3 = Box::new(MockQueueOperation::with_first_prepare(message_id3)) as QueueOperation;

    let batch = vec![op1, op2, op3];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        2,
        "Manual retry (with DB failure) and not submitted operations should be returned for pre-submit"
    );

    // Verify the IDs of operations to pre-submit
    let result_ids: Vec<H256> = result.iter().map(|op| op.id()).collect();
    assert!(
        result_ids.contains(&message_id1),
        "Manual retry operation should be in pre-submit list even with DB store failure"
    );
    assert!(
        result_ids.contains(&message_id3),
        "Not submitted operation should be in pre-submit list"
    );

    // Verify the submitted operation (op2) was pushed to confirm queue
    assert_eq!(
        confirm_queue.len().await,
        1,
        "Submitted operation should be in confirm queue, unaffected by manual operation DB failure"
    );
}

#[tokio::test]
async fn test_filter_operations_for_preparation_all_submitted() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "All submitted operations should go to confirm queue, not pre-submit"
    );

    // Verify all 3 operations were pushed to confirm queue
    assert_eq!(
        confirm_queue.len().await,
        3,
        "All 3 operations should be in confirm queue"
    );
}

#[tokio::test]
async fn test_filter_operations_for_preparation_none_submitted() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        2,
        "All non-submitted operations should be returned for pre-submit"
    );

    // Verify queues are empty when no operations are submitted
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_mixed_batch() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();

    let message_id1 = H256::from_low_u64_be(1); // Manual retry - should go to pre-submit
    let message_id2 = H256::from_low_u64_be(2); // Finalized - should go to confirm
    let message_id3 = H256::from_low_u64_be(3); // Not submitted - should go to pre-submit
    let message_id4 = H256::from_low_u64_be(4); // Pending inclusion - should go to submit queue

    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid4 = UniqueIdentifier::new(Uuid::new_v4());

    // Store should be called once to remove the payload UUID mapping for manual operation
    mock_db
        .expect_store_payload_uuids_by_message_id()
        .times(1)
        .returning(|_, _| Ok(()));

    // Mock DB with flexible expectation handling all operations (including manual after store)
    let payload_uuid2_clone = payload_uuid2.clone();
    let payload_uuid4_clone = payload_uuid4.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(4) // Op1 (manual), Op2, Op3, Op4
        .returning(move |id| {
            if *id == message_id2 {
                Ok(Some(vec![payload_uuid2_clone.clone()]))
            } else if *id == message_id3 {
                Ok(None)
            } else if *id == message_id4 {
                Ok(Some(vec![payload_uuid4_clone.clone()]))
            } else {
                Ok(None) // Op1 manual returns None
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        2,
        "2 operations (manual retry + not submitted) should be returned for pre-submit"
    );

    // Verify the IDs of operations to pre-submit
    let result_ids: Vec<H256> = result.iter().map(|op| op.id()).collect();
    assert!(
        result_ids.contains(&message_id1),
        "Manual retry operation should be in pre-submit list"
    );
    assert!(
        result_ids.contains(&message_id3),
        "Not submitted operation should be in pre-submit list"
    );

    // Verify op2 (finalized) went to confirm queue
    assert_eq!(
        confirm_queue.len().await,
        1,
        "Finalized operation should be in confirm queue"
    );

    // Verify op4 (pending inclusion) went to submit queue
    assert_eq!(
        submit_queue.len().await,
        1,
        "Pending inclusion operation should be in submit queue"
    );
}

#[tokio::test]
async fn test_filter_operations_for_preparation_db_error() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with DB error should be returned for pre-submit"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify queues are empty when DB error occurs
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_payload_dropped() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with dropped payload should be returned for pre-submit"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify queues are empty when payload is dropped
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_transaction_dropped() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with dropped transaction should be returned for pre-submit"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify queues are empty when transaction is dropped
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_entrypoint_error() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with entrypoint error should be returned for pre-submit"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify queues are empty when entrypoint returns error
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_non_manual_retry() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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
    let destination = HyperlaneDomain::new_test_domain("test");
    let op = Box::new(MockQueueOperation::new(
        message_id,
        PendingOperationStatus::Retry(ReprepareReason::ErrorSubmitting),
        destination,
    )) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
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
    assert_eq!(
        confirm_queue.len().await,
        1,
        "Operation should be in confirm queue"
    );
}

#[tokio::test]
async fn test_filter_operations_for_preparation_empty_payload_uuids() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        1,
        "Operation with empty payload UUIDs should be returned for pre-submit"
    );
    assert_eq!(result[0].id(), message_id);

    // Verify queues are empty when payload UUIDs list is empty
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_ready_to_submit_status() {
    // Test that ReadyToSubmit status routes operation to submit queue
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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
        .returning(|_| Ok(PayloadStatus::ReadyToSubmit));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "ReadyToSubmit operation should go to submit queue, not pre-submit"
    );

    // Verify operation was pushed to submit queue
    assert_eq!(
        submit_queue.len().await,
        1,
        "Operation should be in submit queue"
    );
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_mempool_status() {
    // Test that Mempool status routes operation to submit queue
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Mempool)));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Mempool operation should go to submit queue, not pre-submit"
    );

    // Verify operation was pushed to submit queue
    assert_eq!(
        submit_queue.len().await,
        1,
        "Operation should be in submit queue"
    );
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_included_status() {
    // Test that Included status (not just Finalized) routes operation to confirm queue
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
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
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Included)));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;
    let batch = vec![op];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "Included operation should go to confirm queue, not pre-submit"
    );

    // Verify operation was pushed to confirm queue
    assert_eq!(submit_queue.len().await, 0);
    assert_eq!(
        confirm_queue.len().await,
        1,
        "Operation should be in confirm queue"
    );
}

#[tokio::test]
async fn test_filter_operations_for_preparation_all_to_submit_queue() {
    // Test batch where ALL operations route to submit queue
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();

    let message_id1 = H256::from_low_u64_be(1);
    let message_id2 = H256::from_low_u64_be(2);
    let message_id3 = H256::from_low_u64_be(3);

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

    // All operations have PendingInclusion status (Submit disposition)
    mock_entrypoint
        .expect_payload_status()
        .times(3)
        .returning(|_| {
            Ok(PayloadStatus::InTransaction(
                TransactionStatus::PendingInclusion,
            ))
        });

    let op1 = Box::new(MockQueueOperation::with_first_prepare(message_id1)) as QueueOperation;
    let op2 = Box::new(MockQueueOperation::with_first_prepare(message_id2)) as QueueOperation;
    let op3 = Box::new(MockQueueOperation::with_first_prepare(message_id3)) as QueueOperation;

    let batch = vec![op1, op2, op3];

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "All operations with Submit disposition should go to submit queue, not pre-submit"
    );

    // Verify all 3 operations were pushed to submit queue
    assert_eq!(
        submit_queue.len().await,
        3,
        "All 3 operations should be in submit queue"
    );
    assert_eq!(confirm_queue.len().await, 0);
}

#[tokio::test]
async fn test_filter_operations_for_preparation_mix_of_submit_variants() {
    // Test batch with all three Submit disposition variants (ReadyToSubmit, PendingInclusion, Mempool)
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();

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

    let result = filter_operations_for_preparation(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        &submit_queue,
        &confirm_queue,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        batch,
    )
    .await;

    assert_eq!(
        result.len(),
        0,
        "All Submit disposition variants should go to submit queue, not pre-submit"
    );

    // Verify all 3 operations were pushed to submit queue
    assert_eq!(
        submit_queue.len().await,
        3,
        "All 3 Submit disposition variants (ReadyToSubmit, PendingInclusion, Mempool) should be in submit queue"
    );
    assert_eq!(confirm_queue.len().await, 0);
}
