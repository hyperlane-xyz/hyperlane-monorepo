use crate::adapter::AdaptsChain;
use crate::TransactionStatus;

#[tokio::test]
async fn test_reverted_payloads_dropped_with_success_criteria() {
    let adapter = crate::adapter::chains::aleo::adapter::core::tests::create_test_adapter();
    let mut tx = crate::adapter::chains::aleo::adapter::core::tests::create_test_transaction();

    // Add success_criteria to the payload
    tx.payload_details[0].success_criteria = Some(vec![1, 2, 3, 4]);

    // Set transaction status to Dropped
    tx.status = TransactionStatus::Dropped(crate::TransactionDropReason::DroppedByChain);

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // Payload with success_criteria should be marked as reverted
    assert_eq!(reverted.len(), 1);
    assert_eq!(reverted[0].uuid, tx.payload_details[0].uuid);
    assert_eq!(reverted[0].metadata, tx.payload_details[0].metadata);
    assert_eq!(reverted[0].success_criteria, Some(vec![1, 2, 3, 4]));
}

#[tokio::test]
async fn test_reverted_payloads_dropped_without_success_criteria() {
    let adapter = crate::adapter::chains::aleo::adapter::core::tests::create_test_adapter();
    let mut tx = crate::adapter::chains::aleo::adapter::core::tests::create_test_transaction();

    // Ensure no success_criteria
    tx.payload_details[0].success_criteria = None;

    // Set transaction status to Dropped
    tx.status = TransactionStatus::Dropped(crate::TransactionDropReason::DroppedByChain);

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // Payload without success_criteria should NOT be marked as reverted
    assert_eq!(reverted.len(), 0);
}

#[tokio::test]
async fn test_reverted_payloads_finalized_transaction_not_delivered() {
    use hyperlane_aleo::AleoGetMappingValue;

    let adapter = crate::adapter::chains::aleo::adapter::core::tests::create_test_adapter();
    let mut tx = crate::adapter::chains::aleo::adapter::core::tests::create_test_transaction();

    // Add success_criteria with proper AleoGetMappingValue format
    let get_mapping_value = AleoGetMappingValue {
        program_id: "mailbox.aleo".to_string(),
        mapping_name: "deliveries".to_string(),
        mapping_key: "test_key".to_string(),
    };
    tx.payload_details[0].success_criteria = Some(serde_json::to_vec(&get_mapping_value).unwrap());

    // Set transaction status to Finalized
    tx.status = TransactionStatus::Finalized;

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // Payload should be reverted because mock provider returns false (not delivered)
    assert_eq!(reverted.len(), 1);
    assert_eq!(reverted[0].uuid, tx.payload_details[0].uuid);
}

#[tokio::test]
async fn test_reverted_payloads_finalized_transaction_without_success_criteria() {
    let adapter = crate::adapter::chains::aleo::adapter::core::tests::create_test_adapter();
    let mut tx = crate::adapter::chains::aleo::adapter::core::tests::create_test_transaction();

    // Ensure no success_criteria
    tx.payload_details[0].success_criteria = None;

    // Set transaction status to Finalized
    tx.status = TransactionStatus::Finalized;

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // No payloads should be reverted without success_criteria
    assert_eq!(reverted.len(), 0);
}

#[tokio::test]
async fn test_reverted_payloads_pending_transaction() {
    let adapter = crate::adapter::chains::aleo::adapter::core::tests::create_test_adapter();
    let mut tx = crate::adapter::chains::aleo::adapter::core::tests::create_test_transaction();

    // Add success_criteria to the payload
    tx.payload_details[0].success_criteria = Some(vec![1, 2, 3, 4]);

    // Transaction status is PendingInclusion by default
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // No payloads should be reverted for a pending transaction
    assert_eq!(reverted.len(), 0);
}

#[tokio::test]
async fn test_reverted_payloads_mempool_transaction() {
    let adapter = crate::adapter::chains::aleo::adapter::core::tests::create_test_adapter();
    let mut tx = crate::adapter::chains::aleo::adapter::core::tests::create_test_transaction();

    // Add success_criteria to the payload
    tx.payload_details[0].success_criteria = Some(vec![1, 2, 3, 4]);

    // Set transaction status to Mempool
    tx.status = TransactionStatus::Mempool;

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // No payloads should be reverted for a transaction in mempool
    assert_eq!(reverted.len(), 0);
}
