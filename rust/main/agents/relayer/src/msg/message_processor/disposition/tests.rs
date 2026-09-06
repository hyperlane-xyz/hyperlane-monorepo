use std::sync::Arc;

use uuid::Uuid;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::{identifiers::UniqueIdentifier, QueueOperation, H256};
use lander::{
    Entrypoint, LanderError, PayloadDropReason, PayloadRetryReason, PayloadStatus,
    TransactionDropReason, TransactionStatus,
};

use crate::msg::message_processor::tests::tests_common::{
    MockDispatcherEntrypoint, MockHyperlaneDb, MockQueueOperation,
};

use super::super::disposition::{
    awaiting_transaction_finality, operation_disposition_by_payload_status, OperationDisposition,
};

#[tokio::test]
async fn finality_gate_waits_only_for_active_transactions() {
    use hyperlane_core::{
        HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack,
        HyperlaneDomainType, PendingOperationStatus,
    };

    for (status, waiting) in [
        (TransactionStatus::PendingInclusion, true),
        (TransactionStatus::Mempool, true),
        (TransactionStatus::Included, true),
        (TransactionStatus::Finalized, false),
        (
            TransactionStatus::Dropped(TransactionDropReason::FailedSimulation),
            false,
        ),
    ] {
        let message_id = H256::from_low_u64_be(14);
        let payload_uuid = UniqueIdentifier::new(Uuid::new_v4());
        let mut db = MockHyperlaneDb::new();
        db.expect_retrieve_payload_uuids_by_message_id()
            .times(2)
            .returning(move |_| Ok(Some(vec![payload_uuid.clone()])));
        let mut entrypoint = MockDispatcherEntrypoint::new();
        let payload_status = PayloadStatus::InTransaction(status.clone());
        entrypoint
            .expect_payload_status()
            .times(2)
            .returning(move |_| Ok(payload_status.clone()));
        let op: QueueOperation = Box::new(MockQueueOperation::new(
            message_id,
            PendingOperationStatus::ReadyToSubmit,
            HyperlaneDomain::Unknown {
                domain_id: 13375,
                domain_name: "sealeveltest1".to_owned(),
                domain_type: HyperlaneDomainType::LocalTestChain,
                domain_protocol: HyperlaneDomainProtocol::Sealevel,
                domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
            },
        ));
        let entrypoint: Arc<dyn Entrypoint + Send + Sync> = Arc::new(entrypoint);
        let db: Arc<dyn HyperlaneDb> = Arc::new(db);
        assert_eq!(
            awaiting_transaction_finality(entrypoint.clone(), db.clone(), &op).await,
            waiting
        );
        // Inclusion still advances submission, preserving the reveal callback.
        let disposition = operation_disposition_by_payload_status(entrypoint, db, &op).await;
        if matches!(
            status,
            TransactionStatus::Included | TransactionStatus::Finalized
        ) {
            assert!(matches!(
                disposition,
                OperationDisposition::PostSubmitSuccess
            ));
        }
    }
}

#[tokio::test]
async fn finality_gate_allows_external_delivery_confirmation() {
    let mut db = MockHyperlaneDb::new();
    db.expect_retrieve_payload_uuids_by_message_id()
        .times(1)
        .returning(|_| Ok(None));
    let mut entrypoint = MockDispatcherEntrypoint::new();
    entrypoint.expect_payload_status().times(0);
    let op: QueueOperation = Box::new(MockQueueOperation::with_first_prepare(H256::zero()));
    assert!(!awaiting_transaction_finality(Arc::new(entrypoint), Arc::new(db), &op).await);
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
        matches!(result, OperationDisposition::PostSubmitFailure),
        "Should return PostSubmitFailure when payload status is Dropped"
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
        matches!(result, OperationDisposition::PostSubmitFailure),
        "Should return PostSubmitFailure when transaction status is Dropped"
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
        matches!(result, OperationDisposition::Submit),
        "Should return Submit when transaction is pending inclusion"
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
        matches!(result, OperationDisposition::PostSubmitSuccess),
        "Should return PostSubmitSuccess when transaction is finalized"
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
        matches!(result, OperationDisposition::PostSubmitSuccess),
        "Should return PostSubmitSuccess when checking first payload UUID in list"
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
        matches!(result, OperationDisposition::Submit),
        "Should return Submit when payload status is ReadyToSubmit"
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
        matches!(result, OperationDisposition::PostSubmitFailure),
        "Should return PostSubmitFailure when payload needs retry (was dropped/failed)"
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
        matches!(result, OperationDisposition::Submit),
        "Should return Submit when transaction is in mempool (accepted by node)"
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
        matches!(result, OperationDisposition::PostSubmitSuccess),
        "Should return PostSubmitSuccess when transaction is included in unfinalized block"
    );
}
