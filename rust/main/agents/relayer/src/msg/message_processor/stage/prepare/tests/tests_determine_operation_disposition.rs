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
    MockDispatcherEntrypoint, MockQueueOperation,
};

use super::super::{determine_operation_disposition, OperationDisposition};

#[tokio::test]
async fn test_determine_disposition_manual_retry_clears_payload_mapping() {
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();

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

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Manual retry should return PreSubmit disposition after clearing payload mapping"
    );
}

#[tokio::test]
async fn test_determine_disposition_manual_retry_proceeds_despite_db_failure() {
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();

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

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Manual retry should proceed to PreSubmit even with DB failure"
    );
}

#[tokio::test]
async fn test_determine_disposition_non_manual_retry_checks_payload_status() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

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

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmitSuccess),
        "Non-manual retry with finalized payload should return PostSubmitSuccess disposition"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_when_payload_not_found() {
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

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

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "Payload not found should return PreSubmit disposition"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_when_no_payload_uuids() {
    let mut mock_db = MockHyperlaneDb::new();
    let mock_entrypoint = MockDispatcherEntrypoint::new();

    let message_id = H256::from_low_u64_be(1);

    // DB returns None (no payload UUIDs stored yet)
    mock_db
        .expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(None));

    let op = Box::new(MockQueueOperation::with_first_prepare(message_id)) as QueueOperation;

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
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

        let result = determine_operation_disposition(
            Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
            Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
            &op,
        )
        .await;

        assert!(
            matches!(result, OperationDisposition::PostSubmitSuccess),
            "{} status should return PostSubmitSuccess disposition",
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

        let result = determine_operation_disposition(
            Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
            Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
            &op,
        )
        .await;

        assert!(
            matches!(result, OperationDisposition::Submit),
            "{} status should return Submit disposition",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_returns_postsubmit_failure_for_dropped_states() {
    // Test that dropped states return PostSubmitFailure disposition
    // which causes the operation to be sent to confirm queue for verification before re-preparation
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

        let result = determine_operation_disposition(
            Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
            Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
            &op,
        )
        .await;

        assert!(
            matches!(result, OperationDisposition::PostSubmitFailure),
            "{} status should return PostSubmitFailure disposition",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_returns_postsubmit_failure_for_reorged_payload() {
    // Test that reorged payloads return PostSubmitFailure disposition
    // which causes the operation to be sent to confirm queue for verification before re-preparation
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

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

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmitFailure),
        "Reorged payload should return PostSubmitFailure disposition"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_postsubmit_failure_for_all_payload_drop_reasons() {
    // Test that all PayloadDropReason variants return PostSubmitFailure disposition
    // which causes the operation to be sent to confirm queue for verification before re-preparation
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

        let result = determine_operation_disposition(
            Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
            Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
            &op,
        )
        .await;

        assert!(
            matches!(result, OperationDisposition::PostSubmitFailure),
            "{} should return PostSubmitFailure disposition",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_returns_postsubmit_failure_for_all_transaction_drop_reasons() {
    // Test that all transaction drop reasons return PostSubmitFailure disposition
    // which causes the operation to be sent to confirm queue for verification before re-preparation
    let test_cases = vec![
        ("DroppedByChain", TransactionDropReason::DroppedByChain),
        ("FailedSimulation", TransactionDropReason::FailedSimulation),
    ];

    for (test_name, drop_reason) in test_cases {
        let mut mock_db = MockHyperlaneDb::new();
        let mut mock_entrypoint = MockDispatcherEntrypoint::new();

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

        let result = determine_operation_disposition(
            Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
            Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
            &op,
        )
        .await;

        assert!(
            matches!(result, OperationDisposition::PostSubmitFailure),
            "{} should return PostSubmitFailure disposition",
            test_name
        );
    }
}

#[tokio::test]
async fn test_determine_disposition_with_multiple_payload_uuids() {
    // Test that when multiple payload UUIDs exist, only the first is checked
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

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

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PostSubmitSuccess),
        "Should check only first UUID and return PostSubmitSuccess"
    );
}

#[tokio::test]
async fn test_determine_disposition_returns_presubmit_for_entrypoint_error_network() {
    // Test that NetworkError returns PreSubmit
    let mut mock_db = MockHyperlaneDb::new();
    let mut mock_entrypoint = MockDispatcherEntrypoint::new();

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

    let result = determine_operation_disposition(
        Arc::new(mock_entrypoint) as Arc<dyn Entrypoint + Send + Sync>,
        Arc::new(mock_db) as Arc<dyn HyperlaneDb>,
        &op,
    )
    .await;

    assert!(
        matches!(result, OperationDisposition::PreSubmit),
        "NetworkError should return PreSubmit disposition"
    );
}
