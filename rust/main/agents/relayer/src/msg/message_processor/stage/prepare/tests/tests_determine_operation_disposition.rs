use std::sync::Arc;
use uuid::Uuid;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_base::tests::mock_hyperlane_db::MockHyperlaneDb;
use hyperlane_core::identifiers::UniqueIdentifier;
use hyperlane_core::{
    HyperlaneDomain, PendingOperationStatus, QueueOperation, ReprepareReason, H256,
};
use lander::{
    Entrypoint, LanderError, PayloadDropReason, PayloadRetryReason, PayloadStatus,
    TransactionDropReason, TransactionStatus,
};

use crate::msg::message_processor::tests::tests_common::{
    create_test_queue, MockDispatcherEntrypoint, MockQueueOperation,
};

use super::super::filter_operations_for_preparation;

#[tokio::test]
async fn test_determine_disposition_manual_retry_clears_payload_mapping() {
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);

    // Store should be called to clear the payload UUID mapping for manual retry
    mock_db
        .expect_store_payload_uuids_by_message_id()
        .times(1)
        .withf(move |id, uuids| *id == message_id && uuids.is_empty())
        .returning(|_, _| Ok(()));

    // After clearing, retrieve IS called by operation_disposition_by_payload_status
    // and returns None (since we just cleared it)
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(None));

    let op = Box::new(MockQueueOperation::with_manual_retry(message_id)) as QueueOperation;
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
        "Manual retry should return PreSubmit disposition"
    );
    assert_eq!(result[0].id(), message_id);
}

#[tokio::test]
async fn test_determine_disposition_manual_retry_proceeds_despite_db_failure() {
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);

    // Store will fail, but operation should still proceed
    mock_db
        .expect_store_payload_uuids_by_message_id()
        .times(1)
        .returning(|_, _| Err(hyperlane_base::db::DbError::Other("DB failure".to_string())));

    // After store failure, retrieve IS still called by operation_disposition_by_payload_status
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(None));

    let op = Box::new(MockQueueOperation::with_manual_retry(message_id)) as QueueOperation;
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
        "Manual retry should proceed to PreSubmit even with DB failure"
    );
}

#[tokio::test]
async fn test_determine_disposition_non_manual_retry_checks_payload_status() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);
    let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

    // Non-manual retry should check DB and entrypoint
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
        "Non-manual retry with finalized payload should return PostSubmit disposition"
    );

    // Verify operation was pushed to confirm queue
    let queue_contents = confirm_queue.queue.lock().await;
    assert_eq!(queue_contents.len(), 1);
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_when_payload_not_found() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

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
        "Payload not found should return PreSubmit disposition"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_when_no_payload_uuids() {
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);

    // DB returns None (no payload UUIDs stored yet)
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(None));

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
        "No payload UUIDs should return PreSubmit disposition"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_postsubmit_for_various_transaction_states() {
    // Test that finalized/included transaction states return PostSubmit
    let test_cases = vec![
        (
            "Finalized",
            PayloadStatus::InTransaction(TransactionStatus::Finalized),
        ),
        (
            "Included",
            PayloadStatus::InTransaction(TransactionStatus::Included),
        ),
    ];

    for (test_name, payload_status) in test_cases {
        let mut mock_db = MockHyperlaneDb::new();
        let mut mock_entrypoint = MockDispatcherEntrypoint::new();
        let confirm_queue = create_test_queue();
        let submit_queue = create_test_queue();

        let message_id = H256::from_low_u64_be(1);
        let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

        let payload_uuid_clone = payload_uuid.clone();
        mock_db
            .expect_retrieve_payload_uuids_by_message_id()
            .times(1)
            .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

        let status_clone = payload_status.clone();
        mock_entrypoint
            .expect_payload_status()
            .times(1)
            .returning(move |_| Ok(status_clone.clone()));

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
            "{} status should return PostSubmit disposition",
            test_name
        );

        let queue_contents = confirm_queue.queue.lock().await;
        assert_eq!(
            queue_contents.len(),
            1,
            "{} should be in confirm queue",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_returns_submit_for_submission_pipeline_states() {
    // Test that in-progress submission states return Submit disposition
    let test_cases = vec![
        (
            "PendingInclusion",
            PayloadStatus::InTransaction(TransactionStatus::PendingInclusion),
        ),
        ("ReadyToSubmit", PayloadStatus::ReadyToSubmit),
        (
            "Mempool",
            PayloadStatus::InTransaction(TransactionStatus::Mempool),
        ),
    ];

    for (test_name, payload_status) in test_cases {
        let mut mock_db = MockHyperlaneDb::new();
        let mut mock_entrypoint = MockDispatcherEntrypoint::new();
        let confirm_queue = create_test_queue();
        let submit_queue = create_test_queue();

        let message_id = H256::from_low_u64_be(1);
        let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

        let payload_uuid_clone = payload_uuid.clone();
        mock_db
            .expect_retrieve_payload_uuids_by_message_id()
            .times(1)
            .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

        let status_clone = payload_status.clone();
        mock_entrypoint
            .expect_payload_status()
            .times(1)
            .returning(move |_| Ok(status_clone.clone()));

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
            "{} status should return Submit disposition (not returned)",
            test_name
        );

        let submit_contents = submit_queue.queue.lock().await;
        assert_eq!(
            submit_contents.len(),
            1,
            "{} should be in submit queue",
            test_name
        );

        let confirm_contents = confirm_queue.queue.lock().await;
        assert_eq!(
            confirm_contents.len(),
            0,
            "{} should not be in confirm queue",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_for_dropped_states() {
    // Test that dropped states return PreSubmit to allow retry
    let test_cases = vec![
        (
            "PayloadDropped",
            PayloadStatus::Dropped(PayloadDropReason::FailedSimulation),
        ),
        (
            "TransactionDropped",
            PayloadStatus::InTransaction(TransactionStatus::Dropped(
                TransactionDropReason::FailedSimulation,
            )),
        ),
    ];

    for (test_name, payload_status) in test_cases {
        let mut mock_db = MockHyperlaneDb::new();
        let mut mock_entrypoint = MockDispatcherEntrypoint::new();
        let confirm_queue = create_test_queue();
        let submit_queue = create_test_queue();

        let message_id = H256::from_low_u64_be(1);
        let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());

        let payload_uuid_clone = payload_uuid.clone();
        mock_db
            .expect_retrieve_payload_uuids_by_message_id()
            .times(1)
            .returning(move |_| Ok(Some(vec![payload_uuid_clone.clone()])));

        let status_clone = payload_status.clone();
        mock_entrypoint
            .expect_payload_status()
            .times(1)
            .returning(move |_| Ok(status_clone.clone()));

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
            "{} status should return PreSubmit disposition",
            test_name
        );

        let queue_contents = confirm_queue.queue.lock().await;
        assert_eq!(
            queue_contents.len(),
            0,
            "{} should not be in confirm queue",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_for_reorged_payload() {
    // Test that reorged payloads return PreSubmit to allow retry
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

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
        "Reorged payload should return PreSubmit disposition"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_for_all_payload_drop_reasons() {
    // Test that all PayloadDropReason variants return PreSubmit
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
        let confirm_queue = create_test_queue();
        let submit_queue = create_test_queue();

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
            "{} should return PreSubmit disposition",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_for_all_transaction_drop_reasons() {
    // Test that all transaction drop reasons return PreSubmit
    let test_cases = vec![
        ("DroppedByChain", TransactionDropReason::DroppedByChain),
        ("FailedSimulation", TransactionDropReason::FailedSimulation),
    ];

    for (test_name, drop_reason) in test_cases {
        let mut mock_db = MockHyperlaneDb::new();
        let mut mock_entrypoint = MockDispatcherEntrypoint::new();
        let confirm_queue = create_test_queue();
        let submit_queue = create_test_queue();

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
            "{} should return PreSubmit disposition",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_with_multiple_payload_uuids() {
    // Test that when multiple payload UUIDs exist, only the first is checked
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

    let message_id = H256::from_low_u64_be(1);
    let payload_uuid1 = UniqueIdentifier::new(Uuid::new_v4());
    let payload_uuid2 = UniqueIdentifier::new(Uuid::new_v4());

    let payload_uuid1_clone = payload_uuid1.clone();
    let payload_uuid2_clone = payload_uuid2.clone();
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(move |_| {
            Ok(Some(vec![
                payload_uuid1_clone.clone(),
                payload_uuid2_clone.clone(),
            ]))
        });

    // Only the first UUID should be checked
    let payload_uuid1_for_ep = payload_uuid1.clone();
    mock_entrypoint
        .expect_payload_status()
        .times(1)
        .withf(move |uuid| uuid == &payload_uuid1_for_ep)
        .returning(|_| Ok(PayloadStatus::InTransaction(TransactionStatus::Finalized)));

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
        "Should check only first UUID and route to confirm queue"
    );
    assert_eq!(confirm_queue.len().await, 1);
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_for_entrypoint_error_payload_not_found() {
    // Test that PayloadNotFound error returns PreSubmit
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

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
        "PayloadNotFound error should return PreSubmit disposition"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_for_entrypoint_error_network() {
    // Test that NetworkError returns PreSubmit
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();
    let confirm_queue = create_test_queue();
    let submit_queue = create_test_queue();

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
        "NetworkError should return PreSubmit disposition"
    );
}
